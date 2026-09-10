import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GoogleAuthService } from '../google-auth/google-auth.service';
import { CalendarEventDto } from './dto/calendar-event.dto';

const PHONE_REGEX = /(\+?\d[\d\s\-()]{7,}\d)/;
const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const RESUME_LABEL_LINK_REGEX = /(?:resume|cv)\s*:?\s*(https?:\/\/\S+)/i;
const DRIVE_LINK_REGEX = /(https?:\/\/(?:drive|docs)\.google\.com\/\S+)/i;
const INTERVIEWER_LINE_REGEX = /interviewers?\s*:\s*(.+)/i;

const GROQ_BATCH_SIZE = 5;
const MAX_GROQ_RETRIES = 3;

// Default fallback if RECENT_WINDOW_MINUTES is not set in .env.
const DEFAULT_RECENT_WINDOW_MINUTES = 15;

@Injectable()
export class CalendarService {
  private readonly logger = new Logger(CalendarService.name);

  private readonly HR_SCHEDULING_EMAIL: string;

  // Multiple Groq keys let us keep going once one key's daily token quota
  // runs out — we just rotate to the next key instead of failing outright.
  private readonly GROQ_API_KEYS: string[];
  private currentGroqKeyIndex = 0;

  // Only events created/updated/cancelled within this window are shown by
  // this endpoint. Full history is not this endpoint's job — that lives in
  // the Sheet, which keeps everything and applies just the delta each run.
  // Configurable via RECENT_WINDOW_MINUTES in .env (defaults to 15).
  private readonly RECENT_WINDOW_MS: number;

  constructor(
    private readonly googleAuthService: GoogleAuthService,
    private readonly configService: ConfigService,
  ) {
    const configuredEmail = this.configService.get<string>('HR_SCHEDULING_EMAIL');
    if (!configuredEmail) {
      throw new Error(
        'HR_SCHEDULING_EMAIL is not set in .env — please set it before starting the app.',
      );
    }
    this.HR_SCHEDULING_EMAIL = configuredEmail;

    const configuredWindowMinutes = this.configService.get<string>('RECENT_WINDOW_MINUTES');
    const parsedWindowMinutes = configuredWindowMinutes
      ? Number(configuredWindowMinutes)
      : NaN;

    const windowMinutes =
      !Number.isNaN(parsedWindowMinutes) && parsedWindowMinutes > 0
        ? parsedWindowMinutes
        : DEFAULT_RECENT_WINDOW_MINUTES;

    this.RECENT_WINDOW_MS = windowMinutes * 60 * 1000;

    this.logger.log(`Recent event window set to ${windowMinutes} minute(s).`);

    // Primary key is required. GROQ_API_KEY_2 (and beyond, if you ever
    // add GROQ_API_KEY_3 etc.) is optional — add as many as you have.
    const groqKey = this.configService.get<string>('GROQ_API_KEY');
    if (!groqKey) {
      throw new Error(
        'GROQ_API_KEY is not set in .env — please set it before starting the app.',
      );
    }

    const groqKey2 = this.configService.get<string>('GROQ_API_KEY_2');

    this.GROQ_API_KEYS = [groqKey, groqKey2].filter(
      (key): key is string => Boolean(key && key.trim()),
    );

    this.logger.log(`Groq: ${this.GROQ_API_KEYS.length} API key(s) configured for rotation.`);
  }

  async getInterviewEvents(
    timeMin: Date = new Date(),
    timeMax: Date = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
  ): Promise<CalendarEventDto[]> {
    const access_token = await this.googleAuthService.getAccessToken();

    const params = new URLSearchParams({
      timeMin: timeMin.toISOString(),
      timeMax: timeMax.toISOString(),
      singleEvents: 'true',
      showDeleted: 'true',
    });

    const url = `https://www.googleapis.com/calendar/v3/calendars/primary/events?${params.toString()}`;

    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${access_token}` },
    });

    if (!res.ok) {
      const errText = await res.text();
      this.logger.error(`Google Calendar API error ${res.status}: ${errText}`);
      throw new Error(`Failed to fetch calendar events (status ${res.status})`);
    }

    const data: any = await res.json();
    const events: any[] = data.items || [];

    const hrEvents = events.filter((event) => this.isRelevantEvent(event));

    this.logger.log(`Fetched ${events.length} events, ${hrEvents.length} HR events`);

    // Only keep events that were created OR updated (which also covers
    // cancellations, since Google bumps `updated` on delete) within the
    // last 15 minutes. This runs BEFORE the Groq call so we never spend
    // Groq calls on events that would just get filtered out afterwards.
    const recentHrEvents = hrEvents.filter((event) => this.isEventRecent(event));

    this.logger.log(
      `${recentHrEvents.length} of ${hrEvents.length} HR events are within the last 15 minutes — only these go to Groq`,
    );

    const cancelledEvents = recentHrEvents.filter(
      (event) => event.status === 'cancelled' && !event.summary,
    );

    const eventsForGroq = recentHrEvents.filter(
      (event) => !(event.status === 'cancelled' && !event.summary),
    );

    const parsed: CalendarEventDto[] = cancelledEvents.map((event) =>
      this.createCancelledEventDto(event),
    );

    const batches = this.createBatches(eventsForGroq, GROQ_BATCH_SIZE);

    this.logger.log(`Processing ${eventsForGroq.length} events in ${batches.length} Groq batches`);

    for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
      const batch = batches[batchIndex];

      this.logger.debug(
        `Processing Groq batch ${batchIndex + 1}/${batches.length} (${batch.length} events)`,
      );

      const aiResults = await this.parseBatchWithGroq(batch);

      for (let i = 0; i < batch.length; i++) {
        const event = batch[i];
        const aiResult = aiResults[i];

        const dto = this.mapEventToDto(event, aiResult);

        if (dto) {
          parsed.push(dto);
        }
      }

      if (batchIndex < batches.length - 1) {
        await this.sleep(1000);
      }
    }

    parsed.sort((a, b) => {
      const dateA = `${a.date}T${a.time}`;
      const dateB = `${b.date}T${b.time}`;
      return dateA.localeCompare(dateB);
    });

    this.logger.log(
      `Fetched ${events.length} events, ${hrEvents.length} HR events, ${parsed.length} interview events shown (last 15 min window)`,
    );

    // No extra filtering needed here — we already restricted to the
    // recent window before doing any Groq work above.
    return parsed;
  }

  private createBatches<T>(items: T[], batchSize: number): T[][] {
    const batches: T[][] = [];
    for (let i = 0; i < items.length; i += batchSize) {
      batches.push(items.slice(i, i + batchSize));
    }
    return batches;
  }

  private sleep(milliseconds: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }

  private isRelevantEvent(event: any): boolean {
    const attendees = event.attendees || [];

    if (event.status === 'cancelled') {
      if (attendees.length === 0) {
        return true;
      }
      return this.hasHrScheduling(event);
    }

    return this.hasHrScheduling(event);
  }

  private hasHrScheduling(event: any): boolean {
    const attendees = event.attendees || [];
    return attendees.some(
      (a: any) => (a.email || '').toLowerCase() === this.HR_SCHEDULING_EMAIL.toLowerCase(),
    );
  }

  private determineStatus(event: any): 'Active' | 'Updated' {
    const created = event.created ? new Date(event.created).getTime() : null;
    const updated = event.updated ? new Date(event.updated).getTime() : null;

    if (created === null || updated === null) {
      return 'Active';
    }

    const diff = updated - created;
    return diff > 5000 ? 'Updated' : 'Active'; // 5 second buffer
  }

  /**
   * Raw-Google-event check (used BEFORE Groq is called): true if the
   * event was created or updated (Google also bumps `updated` when an
   * event is cancelled/deleted) within the last RECENT_WINDOW_MS.
   * This is what decides whether an event is even worth sending to Groq.
   */
  private isEventRecent(event: any): boolean {
    const createdTs = event.created ? new Date(event.created).getTime() : NaN;
    const updatedTs = event.updated ? new Date(event.updated).getTime() : NaN;

    const now = Date.now();

    const createdRecent = !Number.isNaN(createdTs) && now - createdTs <= this.RECENT_WINDOW_MS;
    const updatedRecent = !Number.isNaN(updatedTs) && now - updatedTs <= this.RECENT_WINDOW_MS;

    return createdRecent || updatedRecent;
  }

  private cleanDescription(raw: string): string {
    if (!raw) {
      return '';
    }

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

    if (attachments.length === 0) {
      return '';
    }

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

    const chosen = resumeLike || attachments[0];

    return chosen.fileUrl || '';
  }

  private async parseBatchWithGroq(events: any[]): Promise<any[]> {
    const formattedEvents = events.map((event, index) => {
      const description = this.cleanDescription(event.description || '');

      const attendees = (event.attendees || []).map((a: any) => a.email).filter(Boolean);

      return {
        index,
        title: event.summary || '',
        description,
        location: event.location || '',
        attendees,
      };
    });

    const prompt = `
You are an expert HR recruitment event parser.

Analyze ALL calendar events below.

For EACH event:

1. Decide whether it is related to a job/recruitment interview.
2. Understand semantic meaning and context.
3. Do NOT depend only on exact keywords.
4. The word "interview" does not have to appear.
5. Do NOT classify normal meetings, team meetings, lunch,
   training, discussions, presentations, or unrelated events
   as interviews.
6. Never guess or invent information.
7. Only use information explicitly supported by the event.
8. Missing fields must be "" or [].
9. Return JSON only.

For each event return:

{
  "index": 0,
  "isInterview": true,
  "position": "",
  "interviewStage": "",
  "type": "",
  "interviewers": [],
  "recruiter": "",
  "contactNumber": "",
  "emailAddress": "",
  "resumeLink": ""
}

FIELD DEFINITIONS:

position:
Job/role being interviewed for.

interviewStage:
Recruitment stage or round.
Examples:
Initial Screening, HR Interview, Technical Interview,
First Round, Second Round, Final Interview, Coding Interview.

type:
Interview method.
Examples:
Online, Onsite, Phone, Video, In-person.

interviewers:
Names or email addresses of interviewers,
only when supported by the event.

recruiter:
Recruiter/HR person only when clearly identifiable.

contactNumber:
Phone number only when explicitly present.

emailAddress:
Candidate/interview-related email only when explicitly
supported. Do NOT assume an attendee is the candidate.

resumeLink:
Resume/CV link only when explicitly present.

Do NOT return candidateName.
Candidate name is handled by the CV parser.

Return exactly one result for every input event.
Keep the same index.

OUTPUT FORMAT — FOLLOW EXACTLY:
Return a single JSON object with exactly one top-level key, "events",
whose value is a JSON array containing one result object per input
event, in the same order as the input. Do not add any other top-level
keys. Do not wrap the JSON in markdown code fences. Example shape:

{
  "events": [
    { "index": 0, "isInterview": true, "position": "...", ... },
    { "index": 1, "isInterview": false, "position": "", ... }
  ]
}

EVENTS:

${JSON.stringify(formattedEvents)}
`;

    for (let attempt = 0; attempt <= MAX_GROQ_RETRIES; attempt++) {
      // Try every configured key once per attempt before falling back to
      // a timed wait — this is what lets a second key pick up the slack
      // the moment the first key's quota/rate-limit kicks in.
      let lastErrorText = '';

      for (let keyTry = 0; keyTry < this.GROQ_API_KEYS.length; keyTry++) {
        const apiKey = this.GROQ_API_KEYS[this.currentGroqKeyIndex];

        try {
          const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: 'openai/gpt-oss-120b',
            messages: [
              {
                role: 'system',
                content: 'You are a precise HR interview event parser. Return only valid JSON.',
              },
              {
                role: 'user',
                content: prompt,
              },
            ],
            temperature: 0,
            response_format: {
              type: 'json_object',
            },
          }),
        });

        if (response.ok) {
          const data: any = await response.json();
          const content = data?.choices?.[0]?.message?.content;

          if (!content) {
            this.logger.warn('Groq returned an empty batch response.');
            return events.map(() => ({}));
          }

          try {
            const parsed = JSON.parse(content);

            if (Array.isArray(parsed)) {
              return this.normalizeBatchResults(parsed, events.length);
            }

            if (Array.isArray(parsed.events)) {
              return this.normalizeBatchResults(parsed.events, events.length);
            }

            if (Array.isArray(parsed.results)) {
              return this.normalizeBatchResults(parsed.results, events.length);
            }

            // Fallback: some models return an object keyed by index instead
            // of an array, e.g. { "0": {...}, "1": {...} }.
            if (parsed && typeof parsed === 'object') {
              const values = Object.values(parsed);
              const looksLikeIndexedResults = values.every(
                (v) => v && typeof v === 'object' && 'isInterview' in (v as any),
              );

              if (values.length > 0 && looksLikeIndexedResults) {
                return this.normalizeBatchResults(values, events.length);
              }
            }

            this.logger.warn(
              `Groq batch response does not contain a recognizable events array. Raw content: ${content}`,
            );
            return events.map(() => ({}));
          } catch {
            this.logger.error(`Groq returned invalid JSON: ${content}`);
            return events.map(() => ({}));
          }
          }

          if (response.status === 429) {
            const errorText = await response.text();
            lastErrorText = errorText;

            this.logger.warn(
              `Groq key #${this.currentGroqKeyIndex + 1}/${this.GROQ_API_KEYS.length} rate-limited (429): ${errorText}`,
            );

            if (this.GROQ_API_KEYS.length > 1) {
              // Rotate to the next key and try it immediately — no wait.
              this.currentGroqKeyIndex =
                (this.currentGroqKeyIndex + 1) % this.GROQ_API_KEYS.length;
              continue; // inner keyTry loop — try the next key right away
            }

            // Only one key configured, nothing to rotate to — fall through
            // to the outer attempt loop's timed backoff below.
            break;
          }

          // Non-429 error — no point rotating keys or retrying, bail out.
          const errorText = await response.text();
          this.logger.error(`Groq API error ${response.status}: ${errorText}`);
          return events.map(() => ({}));
        } catch (error) {
          this.logger.error(
            `Failed to parse batch with Groq: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );

          return events.map(() => ({}));
        }
      }

      // If we got here (without returning above), every configured key
      // was rate-limited this round — back off and try the full key
      // rotation again.
      if (attempt < MAX_GROQ_RETRIES) {
        this.logger.warn(
          `All ${this.GROQ_API_KEYS.length} Groq key(s) rate-limited. Batch retry ${attempt + 1}/${MAX_GROQ_RETRIES}.`,
        );

        let waitTime = 5000 * (attempt + 1);

        const secondsMatch = lastErrorText.match(/try again in ([\d.]+)s/i);

        if (secondsMatch) {
          const seconds = Number(secondsMatch[1]);

          if (!Number.isNaN(seconds)) {
            waitTime = Math.ceil(seconds * 1000) + 1000;
          }
        }

        this.logger.warn(`Waiting ${Math.ceil(waitTime / 1000)} seconds before retry.`);

        await this.sleep(waitTime);

        continue;
      }
    }

    return events.map(() => ({}));
  }

  private normalizeBatchResults(results: any[], eventCount: number): any[] {
    const normalized = Array(eventCount).fill({});

    for (let i = 0; i < results.length; i++) {
      const result = results[i];

      if (result && typeof result === 'object') {
        const index = Number.isInteger(result.index) ? result.index : i;

        if (index >= 0 && index < eventCount) {
          normalized[index] = result;
        }
      }
    }

    return normalized;
  }

  private mapEventToDto(event: any, aiResult: any): CalendarEventDto | null {
    const isCancelled = event.status === 'cancelled';
    const summary: string = event.summary || '';

    if (!aiResult || Object.keys(aiResult).length === 0) {
      this.logger.debug(`Skipping event because Groq returned no result: "${summary}"`);
      return null;
    }

    if (aiResult.isInterview !== true) {
      this.logger.debug(`Skipping non-interview event: "${summary}"`);
      return null;
    }

    const attendees = event.attendees || [];
    const description = this.cleanDescription(event.description || '');

    const startDateTime: string = event.start?.dateTime || event.start?.date || '';

    const [date, timeWithOffset] = startDateTime.includes('T')
      ? startDateTime.split('T')
      : [startDateTime, ''];

    const time = timeWithOffset ? timeWithOffset.slice(0, 5) : '';

    const interviewerLineMatch = description.match(INTERVIEWER_LINE_REGEX);

    let interviewers: string[] = [];

    if (interviewerLineMatch) {
      interviewers = interviewerLineMatch[1]
        .split(',')
        .map((name) => name.trim())
        .filter(Boolean);
    } else if (Array.isArray(aiResult.interviewers)) {
      interviewers = aiResult.interviewers.map((item: any) => String(item).trim()).filter(Boolean);
    }

    const recruiter = aiResult.recruiter || this.extractRecruiter(event, attendees);

    const phoneMatch = description.match(PHONE_REGEX);

    const contactNumber = aiResult.contactNumber || (phoneMatch ? phoneMatch[1].trim() : '');

    const emailMatches = description.match(EMAIL_REGEX) || [];

    const emailAddress = aiResult.emailAddress || emailMatches[0] || '';

    const resumeLink =
      aiResult.resumeLink ||
      this.extractAttachmentResumeLink(event) ||
      this.extractResumeLink(description);

    return {
      candidateName: '',
      position: aiResult.position || '',
      interviewStage: aiResult.interviewStage || '',
      type: aiResult.type || '',
      date,
      time,
      location: event.location || '',
      interviewers,
      recruiter,
      contactNumber,
      emailAddress,
      resumeLink,
      eventId: event.id,
      createdAt: event.created || '',
      updatedAt: event.updated || '',
      status: isCancelled ? 'Cancelled' : this.determineStatus(event),
    };
  }

  private createCancelledEventDto(event: any): CalendarEventDto {
    return {
      candidateName: '',
      position: '',
      interviewStage: '',
      type: '',
      date: '',
      time: '',
      location: '',
      interviewers: [],
      recruiter: '',
      contactNumber: '',
      emailAddress: '',
      resumeLink: '',
      eventId: event.id,
      createdAt: event.created || '',
      updatedAt: event.updated || '',
      status: 'Cancelled',
    };
  }

  private extractRecruiter(event: any, attendees: any[]): string {
    if (event.organizer?.email) {
      return event.organizer.email;
    }

    const recruiterAttendee = attendees.find((a: any) => a.organizer);

    return recruiterAttendee?.email || '';
  }

  private extractResumeLink(description: string): string {
    const labeled = description.match(RESUME_LABEL_LINK_REGEX);

    if (labeled) {
      return labeled[1];
    }

    const drive = description.match(DRIVE_LINK_REGEX);

    if (drive) {
      return drive[1];
    }

    return '';
  }
}