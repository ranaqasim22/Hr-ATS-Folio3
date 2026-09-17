import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';

interface ParsedResume {
  name: string;
  email: string;
  phone: string;
}

@Injectable()
export class ResumeParserService {
  private readonly logger = new Logger(ResumeParserService.name);
  private readonly groqKeys: string[];
  private currentKeyIndex = 0;

  constructor(private readonly configService: ConfigService) {
    const key1 = this.configService.get<string>('GROQ_API_KEY');
    const key2 = this.configService.get<string>('GROQ_API_KEY_2');
    const key3 = this.configService.get<string>('GROQ_API_KEY_3');

    this.groqKeys = [key1, key2, key3].filter((k) => Boolean(k && k.trim())) as string[];

    if (this.groqKeys.length === 0) {
      throw new Error('At least one GROQ_API_KEY is required in .env');
    }

    this.logger.log(`ResumeParser loaded ${this.groqKeys.length} Groq API key(s)`);
  }

  private getNextKey(): string {
    const key = this.groqKeys[this.currentKeyIndex];
    this.currentKeyIndex = (this.currentKeyIndex + 1) % this.groqKeys.length;
    return key;
  }

  private sleep(milliseconds: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }

  async extractData(cvText: string): Promise<ParsedResume> {
    if (!cvText || !cvText.trim()) {
      this.logger.warn('Resume text is empty — nothing to parse from the CV');
      return { name: '', email: '', phone: '' };
    }

    for (let attempt = 0; attempt < 3; attempt++) {
      const apiKey = this.getNextKey();

      try {
        const response = await axios.post(
          'https://api.groq.com/openai/v1/chat/completions',
          {
            model: 'openai/gpt-oss-120b',
            messages: [
              {
                role: 'system',
                content: `You are a resume parser. Extract the following from the CV text:
1. Full Name
2. Email Address
3. Phone Number (look for +92, 03xx, or any digit sequence with 10-15 digits)

Return STRICT JSON with EXACTLY these keys: "name", "email", "phone".
If a field is missing, return empty string "".

Example:
{"name": "John Doe", "email": "john@example.com", "phone": "+92 300 1234567"}`,
              },
              {
                role: 'user',
                content: cvText,
              },
            ],
            response_format: { type: 'json_object' },
            temperature: 0.1,
          },
          {
            headers: {
              Authorization: `Bearer ${apiKey}`,
              'Content-Type': 'application/json',
            },
          },
        );

        const content = response.data.choices[0].message.content;
        const parsed = JSON.parse(content);

        return {
          name: parsed.name || '',
          email: (parsed.email || '').trim().toLowerCase(),
          phone: parsed.phone || '',
        };
      } catch (error) {
        const status = (error as any)?.response?.status;

        if (status === 429) {
          this.logger.warn(
            `Groq resume parse rate-limited (429) — retry ${attempt + 1}/3 with next key`,
          );
          await this.sleep(2000 * (attempt + 1));
          continue;
        }

        this.logger.error(
          `Groq resume parsing failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        break;
      }
    }

    return { name: '', email: '', phone: '' };
  }
}
