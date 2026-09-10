import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';

@Injectable()
export class ResumeParserService {
  private readonly logger = new Logger(ResumeParserService.name);
  private readonly groqKeys: string[];
  private currentKeyIndex = 0;

  constructor(private readonly configService: ConfigService) {
    const key1 = this.configService.get<string>('GROQ_API_KEY');
    const key2 = this.configService.get<string>('GROQ_API_KEY_2');

    this.groqKeys = [key1, key2].filter(Boolean) as string[];

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

  async extractData(cvText: string): Promise<{ name: string; email: string; phone: string }> {
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
        email: parsed.email || '',
        phone: parsed.phone || '',
      };
    } catch (error) {
      this.logger.error(`Groq resume parsing failed: ${error instanceof Error ? error.message : String(error)}`);
      return { name: '', email: '', phone: '' };
    }
  }
}
