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
        // Step 2: Get resume link from event
        const resumeLink = event.resumeLink || '';
        
        if (resumeLink) {
          // Step 3: Download the resume
          const tempPath = await this.driveService.downloadAttachment(resumeLink, 'resume.pdf');
          
          if (tempPath) {
            // Step 4: Extract text from resume
            const resumeText = await this.driveService.extractTextFromResume(tempPath);
            
            // Step 5: Extract structured data using Gemini
            const parsedData = await this.resumeParserService.extractData(resumeText);
            
            // Step 6: Merge parsed data into event
            const fullEvent = {
              ...event,
              contactNumber: parsedData.phone || event.contactNumber,
              emailAddress: parsedData.email || event.emailAddress,
              candidateName: parsedData.name || event.candidateName,
            };
            
            // Step 7: Write to Sheets
            await this.sheetsService.syncEvent(fullEvent);
            
            // Step 8: Clean up temp file
            if (tempPath) {
              const fs = require('fs');
              if (fs.existsSync(tempPath)) {
                fs.unlinkSync(tempPath);
              }
            }
          } else {
            this.logger.warn(`Failed to download resume for event ${event.eventId}`);
          }
        } else {
          this.logger.warn(`No resume link found for event ${event.eventId}`);
        }
      }
      
      this.logger.log(`Sync complete: processed=${events.length}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Sync failed: ${message}`);
    }
  }
}
