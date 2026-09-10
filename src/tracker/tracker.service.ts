import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import * as fs from 'fs';

import { CalendarService } from '../calendar/calendar.service';
import { DriveService } from '../drive/drive.service';
import { SheetsService } from '../sheets/sheets.service';
import { ResumeParserService } from './resume-parser.service';

@Injectable()
export class TrackerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TrackerService.name);
  private syncTimer: NodeJS.Timeout | null = null;
  private syncInProgress = false;

  constructor(
    private readonly calendarService: CalendarService,
    private readonly driveService: DriveService,
    private readonly sheetsService: SheetsService,
    private readonly resumeParserService: ResumeParserService,
  ) {}

  onModuleInit() {
    this.sync().catch((err) =>
      this.logger.error(`Startup sync failed: ${err.message}`),
    );

    const intervalMinutes = Number(process.env.RECENT_WINDOW_MINUTES ?? 0);
    if (intervalMinutes > 0) {
      this.syncTimer = setInterval(() => {
        this.sync().catch((err) =>
          this.logger.error(`Interval sync failed: ${err.message}`),
        );
      }, intervalMinutes * 60 * 1000);
      this.logger.log(
        `Interval sync scheduled every ${intervalMinutes} minute(s).`,
      );
    }
  }

  onModuleDestroy() {
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
    }
  }

  async sync() {
    if (this.syncInProgress) {
      this.logger.warn('Sync already in progress — skipping this run');
      return;
    }
    this.syncInProgress = true;

    this.logger.log('Starting interview sync run');

    try {
      const knownUpdatedAt = await this.sheetsService.getStoredUpdatedAtMap();
      const events = await this.calendarService.getInterviewEvents(
        new Date(),
        new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        knownUpdatedAt,
      );

      let processed = 0;
      for (const event of events) {
        const resumeLink = event.resumeLink || '';

        if (!resumeLink) {
          this.logger.warn(`No resume link found for event ${event.eventId}`);
          continue;
        }

        const tempPath = await this.driveService.downloadAttachment(resumeLink, 'resume.pdf');

        if (!tempPath) {
          this.logger.warn(`Failed to download resume for event ${event.eventId}`);
          continue;
        }

        const resumeText = await this.driveService.extractTextFromResume(tempPath);
        const parsedData = await this.resumeParserService.extractData(resumeText);

        const candidateEmail = (parsedData.email || '').trim().toLowerCase();

        const fullEvent = {
          ...event,
          contactNumber: parsedData.phone || event.contactNumber,
          emailAddress: parsedData.email || event.emailAddress,
          candidateName: parsedData.name || event.candidateName,
          interviewers: candidateEmail
            ? event.interviewers.filter(
                (e: string) => e.trim().toLowerCase() !== candidateEmail,
              )
            : event.interviewers,
        };

        await this.sheetsService.syncEvent(fullEvent);
        processed++;

        if (fs.existsSync(tempPath)) {
          fs.unlinkSync(tempPath);
        }
      }

      this.logger.log(`Sync complete: processed=${processed}`);
    } catch (error) {
      this.logger.error(`Sync failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.syncInProgress = false;
    }
  }
}
