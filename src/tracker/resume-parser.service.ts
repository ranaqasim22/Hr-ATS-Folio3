import { Injectable, Logger } from '@nestjs/common';
import { GoogleGenerativeAI } from '@google/generative-ai';

@Injectable()
export class ResumeParserService {
  private readonly logger = new Logger(ResumeParserService.name);
  private genAI: GoogleGenerativeAI;

  constructor() {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error('GEMINI_API_KEY is not set in .env');
    }
    this.genAI = new GoogleGenerativeAI(apiKey);
  }

  async extractData(cvText: string): Promise<{ name: string; email: string; phone: string }> {
    try {
     const model = this.genAI.getGenerativeModel({ model: 'gemini-3.6-flash' });
      
      const prompt = `
        Extract the following information from this CV text:
        1. Candidate Name
        2. Email Address
        3. Phone Number
        
        Return ONLY a JSON object like:
        {
          "name": "John Doe",
          "email": "john@example.com",
          "phone": "+92 300 1234567"
        }
        
        If a field is not found, return empty string.
        
        CV Text:
        ${cvText}
      `;

      const result = await model.generateContent(prompt);
      const response = await result.response;
      const text = response.text();
      
      // Parse JSON from response
      const cleanedText = text.replace(/```json/g, '').replace(/```/g, '').trim();
      const parsed = JSON.parse(cleanedText);
      
      return {
        name: parsed.name || '',
        email: parsed.email || '',
        phone: parsed.phone || '',
      };
    } catch (error) {
      this.logger.error(`Failed to extract data: ${error.message}`);
      return { name: '', email: '', phone: '' };
    }
  }
}