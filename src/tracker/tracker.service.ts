import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { CalendarService } from '../calendar/calendar.service';
import { DriveService } from '../drive/drive.service';
import { SheetsService } from '../sheets/sheets.service';
import { ResumeParserService } from './resume-parser.service';

@Injectable()
export class TrackerService {
  private readonly logger = new Logger(TrackerService.name);

  constructor(
    private readonly calendarService: CalendarService,
    private readonly driveService: DriveService,
    private readonly sheetsService: SheetsService,
    private readonly resumeParserService: ResumeParserService,
  ) {}

  @Cron('*/15 * * * *')
  async sync() {
    this.logger.log('Starting interview sync run');
    
    try {
      // Step 1: Fetch events from Calendar
      const events = await this.calendarService.getInterviewEvents();
      
      for (const event of events) {
        // Step 2: Extract resume text from CV (DriveService)
        const resumeText = await this.driveService.extractTextFromResume('Umair_Khan_CV.pdf');
        
        // Step 3: Extract structured data using Gemini (ResumeParserService)
        const parsedData = await this.resumeParserService.extractData(resumeText);
        
        // Step 4: Merge parsed data into event
        const fullEvent = {
          ...event,
          contactNumber: parsedData.phone || event.contactNumber,
          emailAddress: parsedData.email || event.emailAddress,
          candidateName: parsedData.name || event.candidateName,
        };
        
        // Step 5: Write to Sheets (SheetsService)
        await this.sheetsService.syncEvent(fullEvent);
      }
      
      this.logger.log(`Sync complete: processed=${events.length}`);
    } catch (error) {
      this.logger.error(`Sync failed: ${error.message}`);
    }
  }
}