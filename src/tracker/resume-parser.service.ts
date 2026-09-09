import { Injectable, Logger } from '@nestjs/common';
import { GoogleGenerativeAI } from '@google/generative-ai';
import axios from 'axios';

@Injectable()
export class ResumeParserService {
  private readonly logger = new Logger(ResumeParserService.name);
  private genAI: GoogleGenerativeAI;
  private groqApiKey: string;

  constructor() {
    const geminiApiKey = process.env.GEMINI_API_KEY;
    this.groqApiKey = process.env.GROQ_API_KEY || '';

    if (!geminiApiKey && !this.groqApiKey) {
      throw new Error('Either GEMINI_API_KEY or GROQ_API_KEY is required');
    }

    if (geminiApiKey) {
      this.genAI = new GoogleGenerativeAI(geminiApiKey);
    }
  }

  async extractData(cvText: string): Promise<{ name: string; email: string; phone: string }> {
    // Try Gemini first
    if (this.genAI) {
      try {
        return await this.extractWithGemini(cvText);
      }  catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn(`Gemini failed: ${message}. Trying Groq...`);
      }
    }

    // Fallback to Groq
    if (this.groqApiKey) {
      try {
        return await this.extractWithGroq(cvText);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error(`Groq also failed: ${message}`);
      }
    }

    return { name: '', email: '', phone: '' };
  }

  private async extractWithGemini(cvText: string): Promise<{ name: string; email: string; phone: string }> {
    const model = this.genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
    
    const prompt = `You are a resume parser. Extract the following from this text:
1. Full Name
2. Email Address  
3. Phone Number

Return a JSON object with EXACTLY these keys: "name", "email", "phone".

Example format:
{"name": "John Doe", "email": "john@example.com", "phone": "+923001234567"}

Text to analyze:
"""${cvText}"""`;

    const result = await model.generateContent(prompt);
    const response = await result.response;
    const text = response.text();
    
    const cleanedText = text
      .replace(/```json/g, '')
      .replace(/```/g, '')
      .trim();
    
    const parsed = JSON.parse(cleanedText);
    
    return {
      name: parsed.name || '',
      email: parsed.email || '',
      phone: parsed.phone || '',
    };
  }

  private async extractWithGroq(cvText: string): Promise<{ name: string; email: string; phone: string }> {
    const response = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        model: 'openai/gpt-oss-120b',  // ✅ Use this model
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
{"name": "John Doe", "email": "john@example.com", "phone": "+92 300 1234567"}`
          },
          {
            role: 'user',
            content: cvText
          }
        ],
        response_format: { type: 'json_object' },
        temperature: 0.1
      },
      {
        headers: {
          'Authorization': `Bearer ${this.groqApiKey}`,
          'Content-Type': 'application/json'
        }
      }
    );

    const content = response.data.choices[0].message.content;
    const parsed = JSON.parse(content);
    
    // If Groq didn't find phone, try regex fallback
    let phone = parsed.phone || '';
    if (!phone) {
      phone = this.extractPhoneWithRegex(cvText);
    }
    
    return {
      name: parsed.name || '',
      email: parsed.email || '',
      phone: phone,
    };
  }

  private extractPhoneWithRegex(cvText: string): string {
    const phoneRegex = /(\+?\d[\d\s\-()]{7,}\d)/;
    const match = cvText.match(phoneRegex);
    return match ? match[1].trim() : '';
  }
}
