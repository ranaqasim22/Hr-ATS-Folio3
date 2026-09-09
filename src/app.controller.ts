import { Controller, Get } from '@nestjs/common';
import { AppService } from './app.service';
import { CalendarService } from './calendar/calendar.service';
import { DriveService } from './drive/drive.service';
import { SheetsService } from './sheets/sheets.service';
import { ResumeParserService } from './tracker/resume-parser.service';

@Controller()
export class AppController {
  constructor(
    private readonly appService: AppService,
    private readonly calendarService: CalendarService,
    private readonly driveService: DriveService,
    private readonly sheetsService: SheetsService,
    private readonly resumeParserService: ResumeParserService,
  ) {}

  @Get()
  getHello(): string {
    return this.appService.getHello();
  }

  @Get('test-full-flow')
  async testFullFlow() {
    try {
      // Step 1: Fetch events
      const events = await this.calendarService.getInterviewEvents();
      
      if (events.length === 0) {
        return { message: 'No events found', events: [] };
      }
      
      const results = [];
      
      for (const event of events) {
        try {
          // Step 2: Get resume link
          const resumeLink = event.resumeLink || '';
          
          if (!resumeLink) {
            results.push({ eventId: event.eventId, error: 'No resume link found' });
            continue;
          }
          
          // Step 3: Download the resume
          const tempPath = await this.driveService.downloadAttachment(resumeLink, 'resume.pdf');
          
          if (!tempPath) {
            results.push({ eventId: event.eventId, error: 'Failed to download resume' });
            continue;
          }
          
          // Step 4: Extract text from resume
          const resumeText = await this.driveService.extractTextFromResume(tempPath);
          
          // Step 5: Parse with Gemini
          const parsedData = await this.resumeParserService.extractData(resumeText);
          
          // Step 6: Merge data
          const fullEvent = {
            ...event,
            contactNumber: parsedData.phone || event.contactNumber,
            emailAddress: parsedData.email || event.emailAddress,
            candidateName: parsedData.name || event.candidateName,
          };
          
          // Step 7: Write to Sheets
          await this.sheetsService.syncEvent(fullEvent);
          
          results.push({
            eventId: event.eventId,
            status: 'success',
            parsed: parsedData
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          results.push({ eventId: event.eventId, error: message });
        }
      }
      
      return {
        message: 'Full flow completed',
        processed: results.length,
        results
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { message: 'Failed', error: message };
    }
  }
}
