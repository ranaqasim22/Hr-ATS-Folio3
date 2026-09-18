import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import * as fs from 'fs';

import { CalendarService } from '../calendar/calendar.service';
import { DriveService } from '../drive/drive.service';
import { SheetsService } from '../sheets/sheets.service';
import { ResumeParserService } from './resume-parser.service';

@Injectable()
export class TrackerService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(
    TrackerService.name,
  );

  private syncTimer: NodeJS.Timeout | null = null;

  private syncInProgress = false;

  /**
   * eventId -> updatedAt
   *
   * Sirf current application run mein
   * same event/version ko dobara process
   * hone se rokta hai.
   */
  private readonly syncedVersions = new Map<
    string,
    string
  >();

  constructor(
    private readonly calendarService: CalendarService,
    private readonly driveService: DriveService,
    private readonly sheetsService: SheetsService,
    private readonly resumeParserService: ResumeParserService,
  ) {}

  onModuleInit() {
    /**
     * Startup par bhi SIRF recent-window wale events process hote hain —
     * poora calendar backfill/reprocess nahi. Pehle yahan recentOnly=false
     * (full sync) tha, jo restart pe HAR baar poori 60-din range ke tamam
     * events dobara Drive/Groq/Sheets se guzarta tha — chahe wo events
     * pehle se Sheet mein sahi/up-to-date stored hon. Isse Groq tokens
     * fazol use hote thay aur restart bhi bohat slow hota tha.
     *
     * Ab startup aur interval dono EXACTLY wahi behavior follow karte
     * hain: sirf jo event pichle RECENT_WINDOW_MINUTES mein naya bana,
     * update hua, ya delete hua — sirf wahi Sheet mein create/update
     * hota hai. Baqi sab (already-synced) skip ho jate hain.
     *
     * true = recentOnly true
     */
    this.sync(true).catch((error) => {
      this.logger.error(
        `Startup sync failed: ${
          error instanceof Error
            ? error.message
            : String(error)
        }`,
      );
    });

    /**
     * Interval:
     * RECENT_WINDOW_MINUTES
     *
     * Example:
     * RECENT_WINDOW_MINUTES=2
     */
    const intervalMinutes = Number(
      process.env.RECENT_WINDOW_MINUTES ?? 0,
    );

    if (intervalMinutes > 0) {
      this.syncTimer = setInterval(() => {
        /**
         * true = recentOnly true
         */
        this.sync(true).catch((error) => {
          this.logger.error(
            `Interval sync failed: ${
              error instanceof Error
                ? error.message
                : String(error)
            }`,
          );
        });
      }, intervalMinutes * 60 * 1000);

      this.logger.log(
        `Interval sync scheduled every ${intervalMinutes} minute(s).`,
      );
    }
  }

  onModuleDestroy() {
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = null;
    }
  }

  async sync(
    recentOnly = true,
  ): Promise<void> {
    if (this.syncInProgress) {
      this.logger.warn(
        'Sync already in progress — skipping this run',
      );
      return;
    }

    this.syncInProgress = true;

    this.logger.log(
      `Starting interview sync run (${
        recentOnly
          ? 'recent events only'
          : 'full startup sync'
      })`,
    );

    try {
      /**
       * STARTUP:
       * 30 days past -> 30 days future
       *
       * INTERVAL:
       * now -> 30 days future
       */
      const timeMin = recentOnly
        ? new Date()
        : new Date(
            Date.now() -
              30 * 24 * 60 * 60 * 1000,
          );

      const timeMax = new Date(
        Date.now() +
          30 * 24 * 60 * 60 * 1000,
      );

      this.logger.log(
        `Calendar range: ${timeMin.toISOString()} -> ${timeMax.toISOString()}`,
      );

      /**
       * IMPORTANT:
       *
       * getStoredUpdatedAtMap() yahan nahi hai.
       *
       * updatedAt Sheet mein store nahi ho raha.
       *
       * CalendarService ko knownUpdatedAt bhi nahi
       * bhej rahe.
       */
      const events =
        await this.calendarService.getInterviewEvents(
          timeMin,
          timeMax,
          {
            recentOnly,
          },
        );

      this.logger.log(
        `CalendarService returned ${events.length} event(s)`,
      );

      let processed = 0;
      let skipped = 0;

      for (const event of events) {
        /**
         * Same event + same version ko current
         * application run mein dobara process
         * nahi karna.
         */
        const version =
          event.updatedAt || '';

        if (
          this.syncedVersions.get(
            event.eventId,
          ) === version
        ) {
          this.logger.debug(
            `Event ${event.eventId} already processed with same version — skipping`,
          );

          skipped++;
          continue;
        }

        const resumeLink =
          event.resumeLink || '';

        if (!resumeLink) {
          this.logger.warn(
            `No resume link found for event ${event.eventId}`,
          );

          skipped++;
          continue;
        }

        let tempPath: string | null =
          null;

        try {
          /**
           * Download resume
           */
          tempPath =
            await this.driveService.downloadAttachment(
              resumeLink,
              'resume.pdf',
            );

          if (!tempPath) {
            this.logger.warn(
              `Failed to download resume for event ${event.eventId}`,
            );

            skipped++;
            continue;
          }

          /**
           * Extract resume text
           */
          const resumeText =
            await this.driveService.extractTextFromResume(
              tempPath,
            );

          if (!resumeText?.trim()) {
            this.logger.warn(
              `Resume text is empty for event ${event.eventId}`,
            );

            skipped++;
            continue;
          }

          /**
           * Parse resume
           */
          const parsedData =
            await this.resumeParserService.extractData(
              resumeText,
            );

          const candidateEmail = (
            parsedData.email || ''
          )
            .trim()
            .toLowerCase();

          /**
           * Combine Calendar + Resume data
           */
          const fullEvent = {
            ...event,

            contactNumber:
              parsedData.phone ||
              event.contactNumber,

            emailAddress:
              parsedData.email ||
              event.emailAddress,

            candidateName:
              parsedData.name ||
              event.candidateName,

            interviewers:
              candidateEmail
                ? (
                    event.interviewers ||
                    []
                  ).filter(
                    (email: string) =>
                      email
                        .trim()
                        .toLowerCase() !==
                      candidateEmail,
                  )
                : event.interviewers,
          };

          /**
           * SheetService itself checks eventId.
           *
           * Existing event:
           * update/reinsert
           *
           * New event:
           * create
           */
          const result =
            await this.sheetsService.syncEvent(
              fullEvent,
            );

          this.logger.log(
            `Sheet sync: eventId=${event.eventId}, action=${result.action}, row=${result.rowIndex}`,
          );

          /**
           * Sirf successful Sheet sync ke baad
           * version remember karo.
           */
          this.syncedVersions.set(
            event.eventId,
            version,
          );

          processed++;
        } catch (error) {
          this.logger.error(
            `Failed processing event ${event.eventId}: ${
              error instanceof Error
                ? error.message
                : String(error)
            }`,
          );
        } finally {
          /**
           * Temporary resume file delete.
           */
          if (
            tempPath &&
            fs.existsSync(tempPath)
          ) {
            try {
              fs.unlinkSync(
                tempPath,
              );
            } catch (error) {
              this.logger.warn(
                `Could not delete temp file ${tempPath}: ${
                  error instanceof Error
                    ? error.message
                    : String(error)
                }`,
              );
            }
          }
        }
      }

      this.logger.log(
        `Sync complete: processed=${processed}, skipped=${skipped}, total=${events.length}`,
      );
    } catch (error) {
      this.logger.error(
        `Sync failed: ${
          error instanceof Error
            ? error.message
            : String(error)
        }`,
      );
    } finally {
      this.syncInProgress = false;
    }
  }
}