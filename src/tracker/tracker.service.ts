import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
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
  // eventId -> updatedAt already synced this process, so the same unchanged
  // event is never downloaded/written twice (prevents "again and again").
  private readonly syncedVersions = new Map<string, string>();

  constructor(
    private readonly calendarService: CalendarService,
    private readonly driveService: DriveService,
    private readonly sheetsService: SheetsService,
    private readonly resumeParserService: ResumeParserService,
    private readonly configService: ConfigService,
  ) {}

  onModuleInit() {
    // Startup: run the sync immediately. A full write (all matching HR
    // events through Groq) is only done when the Sheet is empty — that fills
    // the Sheet on first run. On later restarts a full write would re-send
    // every event to Groq and burn the daily token quota (429) for nothing,
    // so a delta sync (recent window only) is used instead.
    this.checkAndSyncStartup().catch((err) =>
      this.logger.error(`Startup sync failed: ${err.message}`),
    );

    // How often the sync timer fires. Falls back to RECENT_WINDOW_MINUTES for
    // backward compatibility. Kept separate from the recency window on purpose:
    // a short interval (e.g. 1 min) is fine even when the window is larger, but
    // a window of 1 min makes events fall out of range before the timer runs.
    const rawInterval =
      this.configService.get<string>('SYNC_INTERVAL_MINUTES') ??
      this.configService.get<string>('RECENT_WINDOW_MINUTES');

    const intervalMinutes = Number(rawInterval ?? 0);
    if (intervalMinutes > 0) {
      // Interval runs are delta-only (recent window), so they never churn the
      // whole sheet — they just pick up newly created/updated events.
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

  private async checkAndSyncStartup(): Promise<void> {
    const hasEvents = await this.sheetsService.hasStoredEvents();

    if (!hasEvents) {
      this.logger.log('Sheet is empty — running full write sync on startup');
      await this.sync({ full: true });
      return;
    }

    this.logger.log('Sheet already has events — startup sync is delta-only');
    await this.sync();
  }

  async sync(options: { full?: boolean } = {}) {
    if (this.syncInProgress) {
      this.logger.warn('Sync already in progress — skipping this run');
      return;
    }
    this.syncInProgress = true;

    this.logger.log(
      `Starting interview sync run${options.full ? ' (full write)' : ' (delta)'}`,
    );

    try {
      const knownUpdatedAt = await this.sheetsService.getStoredUpdatedAtMap();
      // Delta sync: only events created/updated within RECENT_WINDOW_MINUTES
      // (configured in .env) are processed. The fetch window looks back
      // SYNC_LOOKBACK_DAYS so an event that started before "now" but was just
      // updated is still picked up and synced to the Sheet. On startup (full)
      // every matching HR event in the window is written instead.
      const lookbackDays = Number(this.configService.get('SYNC_LOOKBACK_DAYS') ?? 7) || 7;
      const events = await this.calendarService.getInterviewEvents(
        new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000),
        new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        knownUpdatedAt,
        options.full ? { recentOnly: false } : undefined,
      );

      let processed = 0;
      for (const event of events) {
        // Skip events already synced with this exact updatedAt — prevents the
        // same event being deleted/reappended each interval tick.
        // Two guards: (1) in-memory map for within-run dedup, (2) the sheet-
        // stored updatedAt map so an unchanged event is also skipped on the
        // next app startup without needing a full rewrite every time.
        const ver = event.updatedAt || '';
        if (
          this.syncedVersions.get(event.eventId) === ver ||
          knownUpdatedAt[event.eventId] === ver
        ) {
          continue;
        }

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
        const organizerEmail = (event.recruiter || '').trim().toLowerCase();

        // Union of every email/name seen on the event (attendees, organizer,
        // description and any Groq-derived interviewers), so nothing is lost.
        const allMails = Array.from(
          new Set(
            [
              ...(event.emails || []),
              ...(event.interviewers || []),
              event.recruiter || '',
            ]
              .map((item: string) => item.trim())
              .filter(Boolean),
          ),
        );

        const interviewers = allMails
          .filter((item: string) => item.toLowerCase() !== candidateEmail)
          .filter((item: string) => item.toLowerCase() !== organizerEmail);

        const fullEvent = {
          ...event,
          contactNumber: parsedData.phone || event.contactNumber,
          emailAddress: candidateEmail || event.emailAddress,
          // Candidate name always comes from the calendar event, never the CV.
          candidateName: event.candidateName,
          recruiter: organizerEmail || event.recruiter,
          interviewers,
        };

        await this.sheetsService.syncEvent(fullEvent);
        this.syncedVersions.set(event.eventId, ver);
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
