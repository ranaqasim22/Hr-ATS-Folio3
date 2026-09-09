import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class InterviewParserService {
  private readonly logger = new Logger(InterviewParserService.name);

  private readonly groqApiKey: string;

  constructor(private readonly configService: ConfigService) {
    const key = this.configService.get<string>('GROQ_API_KEY');

    if (!key) {
      throw new Error('GROQ_API_KEY is not set in .env');
    }

    this.groqApiKey = key;
  }

  async parseEvent(eventData: {
    title: string;
    description: string;
    location: string;
    attendees: string[];
  }): Promise<any> {
    const prompt = `
You are an expert HR interview event parser.

Analyze the following Google Calendar event.

Your first task is to determine whether this event is related to a job interview.

IMPORTANT RULES:

1. Do NOT depend only on exact keywords.
2. Understand the meaning and context of the event.
3. Different wording can still mean an interview.
4. Only classify it as an interview when the event is genuinely related
   to a candidate/job interview or recruitment interview.
5. If the event is NOT an interview, return exactly:
   {}
6. Never guess information.
7. Only extract information that is supported by the provided event data.
8. If a field is not available, use an empty string.
9. Return ONLY valid JSON. Do not add explanations.

If it IS an interview, return this structure:

{
  "isInterview": true,
  "candidateName": "",
  "position": "",
  "interviewStage": "",
  "type": "",
  "interviewers": [],
  "recruiter": "",
  "contactNumber": "",
  "emailAddress": "",
  "resumeLink": ""
}

EVENT DATA:

Title:
${eventData.title}

Description:
${eventData.description}

Location:
${eventData.location}

Attendees:
${eventData.attendees.join(', ')}
`;

    const response = await fetch(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.groqApiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'llama-3.3-70b-versatile',
          messages: [
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

    if (!response.ok) {
      const errorText = await response.text();

      this.logger.error(
        `Groq API error ${response.status}: ${errorText}`,
      );

      throw new Error('Failed to parse calendar event using Groq');
    }

    const data = await response.json();

    const content = data.choices?.[0]?.message?.content;

    if (!content) {
      throw new Error('Groq returned an empty response');
    }

    return JSON.parse(content);
  }
}