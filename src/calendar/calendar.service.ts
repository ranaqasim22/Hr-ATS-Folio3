import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GoogleCalendarService } from '@qte/nest-google-calendar';
import { GoogleAuthService } from '../google-auth/google-auth.service';
import { CalendarEventDto } from './dto/calendar-event.dto';

// Basic patterns used to pull structured info out of free-text descriptions.
const PHONE_REGEX = /(\+?\d[\d\s\-()]{7,}\d)/;
const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
// "Resume:" or "CV:" followed by any link, checked before a bare Drive/Docs link.
const RESUME_LABEL_LINK_REGEX = /(?:resume|cv)\s*:?\s*(https?:\/\/\S+)/i;
const DRIVE_LINK_REGEX = /(https?:\/\/(?:drive|docs)\.google\.com\/\S+)/i;
// "Interviewer: Name1, Name2" — lets you name interviewers directly in the
// description instead of relying on who was invited as a calendar guest.
const INTERVIEWER_LINE_REGEX = /interviewers?\s*:\s*(.+)/i;

@Injectable()
export class CalendarService {
  private readonly logger = new Logger(CalendarService.name);

  // Configurable via .env (HR_SCHEDULING_EMAIL). Defaults to the real
  // production address used by Folio3's HR scheduling.
  private readonly HR_SCHEDULING_EMAIL: string;

  constructor(
    private readonly googleCalendarService: GoogleCalendarService,
    private readonly googleAuthService: GoogleAuthService,
    private readonly configService: ConfigService,
  ) {
    this.HR_SCHEDULING_EMAIL =
      this.configService.get<string>('HR_SCHEDULING_EMAIL') || 'hr-scheduling@folio3.com';
  }

  /**
   * Fetches events in [timeMin, timeMax] using @qte/nest-google-calendar,
   * keeps only interview events where HR_SCHEDULING_EMAIL is a guest, and
   * maps each into a CalendarEventDto for downstream modules (Sheets,
   * Drive, AI-testing) to consume.
   */
  async getInterviewEvents(
    timeMin: Date = new Date(),
    timeMax: Date = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // next 30 days
  ): Promise<CalendarEventDto[]> {
    const access_token = await this.googleAuthService.getAccessToken();

    const events = await this.googleCalendarService.getEvents({
      timeMin,
      timeMax,
      access_token,
    });

    const hrEvents = (events || []).filter((event) => this.hasHrScheduling(event));

    const parsed = hrEvents
      .map((event) => this.mapToDto(event))
      .filter((dto): dto is CalendarEventDto => dto !== null);

    this.logger.log(`Fetched ${events?.length ?? 0} events, ${parsed.length} matched HR scheduling`);
    return parsed;
  }

  private hasHrScheduling(event: any): boolean {
    const attendees = event.attendees || [];
    return attendees.some(
      (a: any) => (a.email || '').toLowerCase() === this.HR_SCHEDULING_EMAIL.toLowerCase(),
    );
  }

  /**
   * Parses one raw Google Calendar event into a CalendarEventDto.
   * Subject format expected: "Candidate | Position | Stage | Type"
   * Returns null (and logs) if the subject doesn't match, so one malformed
   * event doesn't crash the whole batch.
   */
  private mapToDto(event: any): CalendarEventDto | null {
    const summary: string = event.summary || '';
    const parts = summary.split('|').map((p: string) => p.trim());

    if (parts.length < 4) {
      this.logger.warn(
        `Skipping event ${event.id}: subject doesn't match "Candidate | Position | Stage | Type" -> "${summary}"`,
      );
      return null;
    }

    const [candidateName, position, interviewStage, type] = parts;

    const startDateTime: string = event.start?.dateTime || event.start?.date || '';
    const [date, timeWithOffset] = startDateTime.includes('T')
      ? startDateTime.split('T')
      : [startDateTime, ''];
    const time = timeWithOffset ? timeWithOffset.slice(0, 5) : '';

    const attendees = event.attendees || [];
    const attendeeEmails: string[] = attendees.map((a: any) => a.email).filter(Boolean);
    const description: string = event.description || '';

    // Prefer an explicit "Interviewer: ..." line in the description — more
    // reliable than guessing from calendar guests, and works even for
    // interviewers without a Google account.
    const interviewerLineMatch = description.match(INTERVIEWER_LINE_REGEX);
    const interviewers = interviewerLineMatch
      ? interviewerLineMatch[1].split(',').map((name) => name.trim()).filter(Boolean)
      : attendeeEmails.filter(
          (email) =>
            email.toLowerCase() !== this.HR_SCHEDULING_EMAIL.toLowerCase() &&
            email.toLowerCase() !== this.guessCandidateEmail(event, attendees),
        );

    const recruiter = this.extractRecruiter(event, attendees);

    const phoneMatch = description.match(PHONE_REGEX);
    const emailMatches = description.match(EMAIL_REGEX) || [];
    const resumeLink = this.extractResumeLink(description);

    return {
      candidateName,
      position,
      interviewStage,
      type,
      date,
      time,
      location: event.location || '',
      interviewers,
      recruiter,
      contactNumber: phoneMatch ? phoneMatch[1].trim() : '',
      emailAddress: emailMatches[0] || '',
      resumeLink,
      eventId: event.id,
    };
  }

  /** Organizer is usually the recruiter who scheduled the interview. */
  private extractRecruiter(event: any, attendees: any[]): string {
    if (event.organizer?.email) return event.organizer.email;
    const recruiterAttendee = attendees.find((a: any) => a.organizer);
    return recruiterAttendee?.email || '';
  }

  /** Best-effort guess so the candidate isn't double-listed as an "interviewer". */
  private guessCandidateEmail(event: any, attendees: any[]): string {
    const candidate = attendees.find(
      (a: any) => !a.organizer && (a.responseStatus === 'needsAction' || a.resource !== true),
    );
    return (candidate?.email || '').toLowerCase();
  }

  /** Finds a resume/CV link in the description, if any is present. */
  private extractResumeLink(description: string): string {
    const labeled = description.match(RESUME_LABEL_LINK_REGEX);
    if (labeled) return labeled[1];

    const drive = description.match(DRIVE_LINK_REGEX);
    if (drive) return drive[1];

    return '';
  }
}
