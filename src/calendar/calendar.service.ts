import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GoogleCalendarService } from '@qte/nest-google-calendar';
import { GoogleAuthService } from '../google-auth/google-auth.service';
import { CalendarEventDto } from './dto/calendar-event.dto';

const PHONE_REGEX = /(\+?\d[\d\s\-()]{7,}\d)/;
const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const RESUME_LABEL_LINK_REGEX = /(?:resume|cv)\s*:?\s*(https?:\/\/\S+)/i;
const DRIVE_LINK_REGEX = /(https?:\/\/(?:drive|docs)\.google\.com\/\S+)/i;
const INTERVIEWER_LINE_REGEX = /interviewers?\s*:\s*(.+)/i;

const TYPE_KEYWORDS = [
  'online', 'onsite', 'on-site', 'in-person', 'in person',
  'phone', 'telephonic', 'virtual', 'video', 'in-office',
];

const STAGE_KEYWORDS = [
  '1st interview', '2nd interview', '3rd interview', 'final interview',
  'screening', 'technical interview', 'technical round', 'hr interview',
  'hr round', 'final round', 'interview', 'round',
];

const POSITION_KEYWORDS = [
  'developer', 'engineer', 'designer', 'analyst', 'manager', 'lead',
  'intern', 'architect', 'consultant', 'specialist', 'officer',
  'executive', 'scientist', 'tester', 'qa',
];

@Injectable()
export class CalendarService {
  private readonly logger = new Logger(CalendarService.name);

  private readonly HR_SCHEDULING_EMAIL: string;

  constructor(
    private readonly googleCalendarService: GoogleCalendarService,
    private readonly googleAuthService: GoogleAuthService,
    private readonly configService: ConfigService,
  ) {this.HR_SCHEDULING_EMAIL = this.configService.get<string>('HR_SCHEDULING_EMAIL');

if (!this.HR_SCHEDULING_EMAIL) {
  throw new Error('HR_SCHEDULING_EMAIL is not set in .env file');
}}

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

  private cleanDescription(raw: string): string {
    if (!raw) return '';

    return raw
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n')
      .replace(/<\/div>/gi, '\n')
      .replace(/<a[^>]*href=["']([^"']+)["'][^>]*>.*?<\/a>/gis, '$1')
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&')
      .replace(/&nbsp;/g, ' ')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .trim();
  }

  private extractAttachmentResumeLink(event: any): string {
    const attachments = event.attachments || [];
    if (attachments.length === 0) return '';

    const resumeLike = attachments.find((a: any) => {
      const title = (a.title || '').toLowerCase();
      const mime = (a.mimeType || '').toLowerCase();
      return (
        title.includes('resume') ||
        title.includes('cv') ||
        mime.includes('pdf') ||
        mime.includes('word') ||
        mime.includes('document')
      );
    });

    const chosen = resumeLike || attachments[0]; // fallback: first attachment
    return chosen.fileUrl || '';
  }

  private classifyTitleParts(parts: string[]): {
    candidateName: string;
    position: string;
    interviewStage: string;
    type: string;
  } {
    let type = '';
    let stage = '';
    let position = '';
    const remaining: string[] = [];

    for (const part of parts) {
      const lower = part.toLowerCase();

      if (!type && TYPE_KEYWORDS.some((k) => lower.includes(k))) {
        type = part;
        continue;
      }
      if (!stage && STAGE_KEYWORDS.some((k) => lower.includes(k))) {
        stage = part;
        continue;
      }
      if (!position && POSITION_KEYWORDS.some((k) => lower.includes(k))) {
        position = part;
        continue;
      }
      remaining.push(part);
    }

    if (!position && remaining.length > 1) {
      position = remaining.shift() as string;
    }

    const candidateName = remaining.shift() || '';

    return { candidateName, position, interviewStage: stage, type };
  }

  private mapToDto(event: any): CalendarEventDto | null {
    const summary: string = event.summary || '';
    const parts = summary.split('|').map((p: string) => p.trim()).filter(Boolean);

    if (parts.length < 2) {
      this.logger.warn(
        `Skipping event ${event.id}: title too short to parse -> "${summary}"`,
      );
      return null;
    }

    const { candidateName, position, interviewStage, type } = this.classifyTitleParts(parts);

    if (!candidateName) {
      this.logger.warn(
        `Skipping event ${event.id}: could not identify candidate name -> "${summary}"`,
      );
      return null;
    }

    const startDateTime: string = event.start?.dateTime || event.start?.date || '';
    const [date, timeWithOffset] = startDateTime.includes('T')
      ? startDateTime.split('T')
      : [startDateTime, ''];
    const time = timeWithOffset ? timeWithOffset.slice(0, 5) : '';

    const attendees = event.attendees || [];
    const attendeeEmails: string[] = attendees.map((a: any) => a.email).filter(Boolean);
    const description: string = this.cleanDescription(event.description || '');

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

    const resumeLink =
      this.extractAttachmentResumeLink(event) || this.extractResumeLink(description);

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

  private extractRecruiter(event: any, attendees: any[]): string {
    if (event.organizer?.email) return event.organizer.email;
    const recruiterAttendee = attendees.find((a: any) => a.organizer);
    return recruiterAttendee?.email || '';
  }

  private guessCandidateEmail(event: any, attendees: any[]): string {
    const candidate = attendees.find(
      (a: any) => !a.organizer && (a.responseStatus === 'needsAction' || a.resource !== true),
    );
    return (candidate?.email || '').toLowerCase();
  }

  private extractResumeLink(description: string): string {
    const labeled = description.match(RESUME_LABEL_LINK_REGEX);
    if (labeled) return labeled[1];

    const drive = description.match(DRIVE_LINK_REGEX);
    if (drive) return drive[1];

    return '';
  }
}
