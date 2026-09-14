import { Module } from '@nestjs/common';
import { ResumeParserService } from './resume-parser.service';
import { TrackerService } from './tracker.service';
import { CalendarModule } from '../calendar/calendar.module';
import { DriveModule } from '../drive/drive.module';
import { SheetsModule } from '../sheets/sheets.module';

@Module({
  imports: [
    CalendarModule,  // ✅ For CalendarService
    DriveModule,     // ✅ For DriveService
    SheetsModule,    // ✅ For SheetsService
  ],
  providers: [
    TrackerService,         // ✅ TrackerService
    ResumeParserService,    // ✅ ResumeParserService
  ],
  exports: [TrackerService, ResumeParserService],
})
export class TrackerModule {}