import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GoogleAuthService } from '../google-auth/google-auth.service';
import { CalendarEventDto } from './dto/calendar-event.dto';

const PHONE_REGEX = /(\+?\d[\d\s\-()]{7,}\d)/;

const EMAIL_REGEX =
  /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

const RESUME_LABEL_LINK_REGEX =
  /(?:resume|cv)\s*:?\s*(https?:\/\/\S+)/i;

const DRIVE_LINK_REGEX =
  /(https?:\/\/(?:drive|docs)\.google\.com\/\S+)/i;

const INTERVIEWER_LINE_REGEX =
  /interviewers?\s*:\s*(.+)/i;

/*
 * Number of calendar events sent to Groq
 * in one request.
 *
 * 5 is small enough to stay comfortably
 * within the token limit while reducing
 * the number of API requests.
 */
const GROQ_BATCH_SIZE = 5;

/*
 * Maximum number of retries when Groq
 * returns HTTP 429.
 */
const MAX_GROQ_RETRIES = 3;

@Injectable()
export class CalendarService {
  private readonly logger = new Logger(
    CalendarService.name,
  );

  private readonly HR_SCHEDULING_EMAIL: string;
  private readonly GROQ_API_KEY: string;

  constructor(
    private readonly googleAuthService: GoogleAuthService,
    private readonly configService: ConfigService,
  ) {
    const configuredEmail =
      this.configService.get<string>(
        'HR_SCHEDULING_EMAIL',
      );

    if (!configuredEmail) {
      throw new Error(
        'HR_SCHEDULING_EMAIL is not set in .env — please set it before starting the app.',
      );
    }

    this.HR_SCHEDULING_EMAIL =
      configuredEmail;

    const groqKey =
      this.configService.get<string>(
        'GROQ_API_KEY',
      );

    if (!groqKey) {
      throw new Error(
        'GROQ_API_KEY is not set in .env — please set it before starting the app.',
      );
    }

    this.GROQ_API_KEY = groqKey;
  }

  async getInterviewEvents(
    timeMin: Date = new Date(),
    timeMax: Date = new Date(
      Date.now() +
        30 * 24 * 60 * 60 * 1000,
    ),
  ): Promise<CalendarEventDto[]> {
    const access_token =
      await this.googleAuthService.getAccessToken();

    const params = new URLSearchParams({
      timeMin: timeMin.toISOString(),
      timeMax: timeMax.toISOString(),
      singleEvents: 'true',
      showDeleted: 'true',
    });

    const url =
      `https://www.googleapis.com/calendar/v3/calendars/primary/events?${params.toString()}`;

    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${access_token}`,
      },
    });

    if (!res.ok) {
      const errText = await res.text();

      this.logger.error(
        `Google Calendar API error ${res.status}: ${errText}`,
      );

      throw new Error(
        `Failed to fetch calendar events (status ${res.status})`,
      );
    }

    const data: any = await res.json();

    const events: any[] =
      data.items || [];

    /*
     * First filter by HR scheduling email.
     *
     * This prevents unrelated calendar events
     * from being sent to Groq.
     */
    const hrEvents =
      events.filter((event) =>
        this.isRelevantEvent(event),
      );

    this.logger.log(
      `Fetched ${events.length} events, ` +
        `${hrEvents.length} HR events`,
    );

    /*
     * Process cancelled events without title
     * separately because there is no information
     * for Groq to classify.
     */
    const cancelledEvents =
      hrEvents.filter(
        (event) =>
          event.status === 'cancelled' &&
          !event.summary,
      );

    const eventsForGroq =
      hrEvents.filter(
        (event) =>
          !(
            event.status === 'cancelled' &&
            !event.summary
          ),
      );

    const parsed: CalendarEventDto[] =
      cancelledEvents.map(
        (event) =>
          this.createCancelledEventDto(
            event,
          ),
      );

    /*
     * Split events into batches.
     *
     * Example:
     *
     * 34 events
     * ↓
     * Batch 1 = 5
     * Batch 2 = 5
     * Batch 3 = 5
     * ...
     */
    const batches =
      this.createBatches(
        eventsForGroq,
        GROQ_BATCH_SIZE,
      );

    this.logger.log(
      `Processing ${eventsForGroq.length} events ` +
        `in ${batches.length} Groq batches`,
    );

    /*
     * Process batches ONE BY ONE.
     *
     * We intentionally do NOT use Promise.all()
     * here because that would create multiple
     * Groq requests at the same time.
     */
    for (
      let batchIndex = 0;
      batchIndex < batches.length;
      batchIndex++
    ) {
      const batch =
        batches[batchIndex];

      this.logger.debug(
        `Processing Groq batch ${batchIndex + 1}/${batches.length} ` +
          `(${batch.length} events)`,
      );

      const aiResults =
        await this.parseBatchWithGroq(
          batch,
        );

      /*
       * Convert each event + its AI result
       * into our existing CalendarEventDto.
       */
      for (
        let i = 0;
        i < batch.length;
        i++
      ) {
        const event = batch[i];
        const aiResult =
          aiResults[i];

        const dto =
          this.mapEventToDto(
            event,
            aiResult,
          );

        if (dto) {
          parsed.push(dto);
        }
      }

      /*
       * Small delay between batches.
       *
       * This gives the TPM window some time
       * to recover and reduces 429 errors.
       */
      if (
        batchIndex <
        batches.length - 1
      ) {
        await this.sleep(1000);
      }
    }

    /*
     * Keep calendar order.
     */
    parsed.sort(
      (a, b) => {
        const dateA =
          `${a.date}T${a.time}`;

        const dateB =
          `${b.date}T${b.time}`;

        return dateA.localeCompare(
          dateB,
        );
      },
    );

    this.logger.log(
      `Fetched ${events.length} events, ` +
        `${hrEvents.length} HR events, ` +
        `${parsed.length} interview events`,
    );

    return parsed;
  }

  /**
   * Creates batches from an array.
   */
  private createBatches<T>(
    items: T[],
    batchSize: number,
  ): T[][] {
    const batches: T[][] = [];

    for (
      let i = 0;
      i < items.length;
      i += batchSize
    ) {
      batches.push(
        items.slice(
          i,
          i + batchSize,
        ),
      );
    }

    return batches;
  }

  /**
   * Simple delay helper.
   */
  private sleep(
    milliseconds: number,
  ): Promise<void> {
    return new Promise(
      (resolve) =>
        setTimeout(
          resolve,
          milliseconds,
        ),
    );
  }

  /**
   * Checks whether the event belongs
   * to the HR scheduling calendar flow.
   */
  private isRelevantEvent(
    event: any,
  ): boolean {
    const attendees =
      event.attendees || [];

    if (
      event.status ===
      'cancelled'
    ) {
      if (
        attendees.length === 0
      ) {
        return true;
      }

      return this.hasHrScheduling(
        event,
      );
    }

    return this.hasHrScheduling(
      event,
    );
  }

  /**
   * Checks whether HR scheduling email
   * exists among attendees.
   */
  private hasHrScheduling(
    event: any,
  ): boolean {
    const attendees =
      event.attendees || [];

    return attendees.some(
      (a: any) =>
        (a.email || '').toLowerCase() ===
        this.HR_SCHEDULING_EMAIL.toLowerCase(),
    );
  }

  /**
   * Removes HTML from Google Calendar
   * descriptions.
   */
  private cleanDescription(
    raw: string,
  ): string {
    if (!raw) {
      return '';
    }

    return raw
      .replace(
        /<br\s*\/?>/gi,
        '\n',
      )
      .replace(
        /<\/p>/gi,
        '\n',
      )
      .replace(
        /<\/div>/gi,
        '\n',
      )
      .replace(
        /<a[^>]*href=["']([^"']+)["'][^>]*>.*?<\/a>/gis,
        '$1',
      )
      .replace(
        /<[^>]+>/g,
        '',
      )
      .replace(
        /&amp;/g,
        '&',
      )
      .replace(
        /&nbsp;/g,
        ' ',
      )
      .replace(
        /&lt;/g,
        '<',
      )
      .replace(
        /&gt;/g,
        '>',
      )
      .trim();
  }

  /**
   * Extracts a resume/CV link from
   * Google Calendar attachments.
   */
  private extractAttachmentResumeLink(
    event: any,
  ): string {
    const attachments =
      event.attachments || [];

    if (
      attachments.length === 0
    ) {
      return '';
    }

    const resumeLike =
      attachments.find(
        (a: any) => {
          const title =
            (
              a.title || ''
            ).toLowerCase();

          const mime =
            (
              a.mimeType || ''
            ).toLowerCase();

          return (
            title.includes(
              'resume',
            ) ||
            title.includes(
              'cv',
            ) ||
            mime.includes(
              'pdf',
            ) ||
            mime.includes(
              'word',
            ) ||
            mime.includes(
              'document',
            )
          );
        },
      );

    const chosen =
      resumeLike ||
      attachments[0];

    return (
      chosen.fileUrl || ''
    );
  }

  /**
   * Sends a BATCH of calendar events
   * to Groq.
   *
   * One Groq request handles multiple
   * calendar events.
   */
  private async parseBatchWithGroq(
    events: any[],
  ): Promise<any[]> {
    const formattedEvents =
      events.map(
        (event, index) => {
          const description =
            this.cleanDescription(
              event.description ||
                '',
            );

          const attendees =
            (event.attendees ||
              [])
              .map(
                (a: any) =>
                  a.email,
              )
              .filter(Boolean);

          return {
            index,
            title:
              event.summary || '',
            description,
            location:
              event.location || '',
            attendees,
          };
        },
      );

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

EVENTS:

${JSON.stringify(
  formattedEvents,
)}
`;

    for (
      let attempt = 0;
      attempt <= MAX_GROQ_RETRIES;
      attempt++
    ) {
      try {
        const response =
          await fetch(
            'https://api.groq.com/openai/v1/chat/completions',
            {
              method: 'POST',

              headers: {
                Authorization:
                  `Bearer ${this.GROQ_API_KEY}`,

                'Content-Type':
                  'application/json',
              },

              body: JSON.stringify({
                model:
                  'openai/gpt-oss-120b',

                messages: [
                  {
                    role: 'system',
                    content:
                      'You are a precise HR interview event parser. Return only valid JSON.',
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
            },
          );

        /*
         * Successful response.
         */
        if (response.ok) {
          const data: any =
            await response.json();

          const content =
            data?.choices?.[0]
              ?.message?.content;

          if (!content) {
            this.logger.warn(
              'Groq returned an empty batch response.',
            );

            return events.map(
              () => ({}),
            );
          }

          try {
            const parsed =
              JSON.parse(content);

            /*
             * Expected response:
             *
             * {
             *   "events": [...]
             * }
             *
             * But we also handle a direct
             * array just in case.
             */
            if (
              Array.isArray(
                parsed,
              )
            ) {
              return this.normalizeBatchResults(
                parsed,
                events.length,
              );
            }

            if (
              Array.isArray(
                parsed.events,
              )
            ) {
              return this.normalizeBatchResults(
                parsed.events,
                events.length,
              );
            }

            this.logger.warn(
              'Groq batch response does not contain an events array.',
            );

            return events.map(
              () => ({}),
            );
          } catch {
            this.logger.error(
              `Groq returned invalid JSON: ${content}`,
            );

            return events.map(
              () => ({}),
            );
          }
        }

        /*
         * Handle rate limit.
         */
        if (
          response.status === 429 &&
          attempt <
            MAX_GROQ_RETRIES
        ) {
          const errorText =
            await response.text();

          this.logger.warn(
            `Groq rate limit reached. ` +
              `Batch retry ${attempt + 1}/${MAX_GROQ_RETRIES}.`,
          );

          /*
           * Default retry delays.
           */
          let waitTime =
            5000 *
            (attempt + 1);

          /*
           * Groq usually tells us:
           *
           * "Please try again in 6.645s"
           */
          const secondsMatch =
            errorText.match(
              /try again in ([\d.]+)s/i,
            );

          if (secondsMatch) {
            const seconds =
              Number(
                secondsMatch[1],
              );

            if (
              !Number.isNaN(
                seconds,
              )
            ) {
              /*
               * Add 1 second buffer.
               */
              waitTime =
                Math.ceil(
                  seconds * 1000,
                ) + 1000;
            }
          }

          this.logger.warn(
            `Waiting ${Math.ceil(
              waitTime / 1000,
            )} seconds before retry.`,
          );

          await this.sleep(
            waitTime,
          );

          continue;
        }

        /*
         * Other Groq errors.
         */
        const errorText =
          await response.text();

        this.logger.error(
          `Groq API error ${response.status}: ${errorText}`,
        );

        return events.map(
          () => ({}),
        );
      } catch (error) {
        this.logger.error(
          `Failed to parse batch with Groq: ${
            error instanceof Error
              ? error.message
              : String(error)
          }`,
        );

        return events.map(
          () => ({}),
        );
      }
    }

    return events.map(
      () => ({}),
    );
  }

  /**
   * Makes sure we have one AI result
   * for every event in the batch.
   */
  private normalizeBatchResults(
    results: any[],
    eventCount: number,
  ): any[] {
    const normalized =
      Array(eventCount).fill({});

    for (
      let i = 0;
      i < results.length;
      i++
    ) {
      const result =
        results[i];

      if (
        result &&
        typeof result ===
          'object'
      ) {
        const index =
          Number.isInteger(
            result.index,
          )
            ? result.index
            : i;

        if (
          index >= 0 &&
          index < eventCount
        ) {
          normalized[index] =
            result;
        }
      }
    }

    return normalized;
  }

  /**
   * Converts one Google Calendar event
   * and its Groq result into DTO.
   *
   * Returns null when the event is not
   * an interview.
   */
  private mapEventToDto(
    event: any,
    aiResult: any,
  ): CalendarEventDto | null {
    const isCancelled =
      event.status ===
      'cancelled';

    const summary: string =
      event.summary || '';

    /*
     * If Groq could not classify this
     * event, ignore it.
     */
    if (
      !aiResult ||
      Object.keys(aiResult)
        .length === 0
    ) {
      this.logger.debug(
        `Skipping event because Groq returned no result: "${summary}"`,
      );

      return null;
    }

    /*
     * Only explicitly classified
     * interviews are accepted.
     */
    if (
      aiResult.isInterview !== true
    ) {
      this.logger.debug(
        `Skipping non-interview event: "${summary}"`,
      );

      return null;
    }

    const attendees =
      event.attendees || [];

    const description =
      this.cleanDescription(
        event.description ||
          '',
      );

    /*
     * Date and time remain deterministic.
     */
    const startDateTime: string =
      event.start?.dateTime ||
      event.start?.date ||
      '';

    const [
      date,
      timeWithOffset,
    ] =
      startDateTime.includes('T')
        ? startDateTime.split(
            'T',
          )
        : [
            startDateTime,
            '',
          ];

    const time =
      timeWithOffset
        ? timeWithOffset.slice(
            0,
            5,
          )
        : '';

    /*
     * Interviewers:
     *
     * 1. Explicit "Interviewers:"
     *    line from description
     *
     * 2. Groq result
     */
    const interviewerLineMatch =
      description.match(
        INTERVIEWER_LINE_REGEX,
      );

    let interviewers: string[] =
      [];

    if (
      interviewerLineMatch
    ) {
      interviewers =
        interviewerLineMatch[1]
          .split(',')
          .map(
            (name) =>
              name.trim(),
          )
          .filter(Boolean);
    } else if (
      Array.isArray(
        aiResult.interviewers,
      )
    ) {
      interviewers =
        aiResult.interviewers
          .map(
            (item: any) =>
              String(
                item,
              ).trim(),
          )
          .filter(Boolean);
    }

    /*
     * Recruiter:
     *
     * 1. Groq
     * 2. Organizer fallback
     */
    const recruiter =
      aiResult.recruiter ||
      this.extractRecruiter(
        event,
        attendees,
      );

    /*
     * Contact number:
     *
     * 1. Groq
     * 2. Regex fallback
     */
    const phoneMatch =
      description.match(
        PHONE_REGEX,
      );

    const contactNumber =
      aiResult.contactNumber ||
      (phoneMatch
        ? phoneMatch[1].trim()
        : '');

    /*
     * Email:
     *
     * 1. Groq
     * 2. Description regex
     */
    const emailMatches =
      description.match(
        EMAIL_REGEX,
      ) || [];

    const emailAddress =
      aiResult.emailAddress ||
      emailMatches[0] ||
      '';

    /*
     * Resume:
     *
     * 1. Groq
     * 2. Calendar attachment
     * 3. Description
     */
    const resumeLink =
      aiResult.resumeLink ||
      this.extractAttachmentResumeLink(
        event,
      ) ||
      this.extractResumeLink(
        description,
      );

    /*
     * candidateName intentionally remains
     * empty because CV parser handles it.
     */
    return {
      candidateName: '',

      position:
        aiResult.position ||
        '',

      interviewStage:
        aiResult.interviewStage ||
        '',

      type:
        aiResult.type ||
        '',

      date,

      time,

      location:
        event.location ||
        '',

      interviewers,

      recruiter,

      contactNumber,

      emailAddress,

      resumeLink,

      eventId:
        event.id,

      status:
        isCancelled
          ? 'Cancelled'
          : 'Active',
    };
  }

  /**
   * Creates DTO for a cancelled event
   * which has no title.
   */
  private createCancelledEventDto(
    event: any,
  ): CalendarEventDto {
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
      eventId:
        event.id,
      status: 'Cancelled',
    };
  }

  /**
   * Extract recruiter from organizer/attendees.
   */
  private extractRecruiter(
    event: any,
    attendees: any[],
  ): string {
    if (
      event.organizer?.email
    ) {
      return event.organizer.email;
    }

    const recruiterAttendee =
      attendees.find(
        (a: any) =>
          a.organizer,
      );

    return (
      recruiterAttendee?.email ||
      ''
    );
  }

  /**
   * Extracts a resume/CV link
   * from description.
   */
  private extractResumeLink(
    description: string,
  ): string {
    const labeled =
      description.match(
        RESUME_LABEL_LINK_REGEX,
      );

    if (labeled) {
      return labeled[1];
    }

    const drive =
      description.match(
        DRIVE_LINK_REGEX,
      );

    if (drive) {
      return drive[1];
    }

    return '';
  }
}