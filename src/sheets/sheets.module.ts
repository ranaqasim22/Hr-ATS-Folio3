import { Module } from '@nestjs/common';
import { GoogleSheetModule } from '@icetee/nest-google-sheet-connector';
import * as fs from 'fs';
import * as path from 'path';
import { SheetsService } from './sheets.service';
import { SheetsController } from './sheets.controller';
import { CalendarModule } from '../calendar/calendar.module';

@Module({
  imports: [
    CalendarModule, 
    GoogleSheetModule.registerAsync({
      useFactory: () => {
        const keyPath = process.env.GOOGLE_SHEETS_SERVICE_ACCOUNT_KEY_PATH;

        if (!keyPath) {
          throw new Error(
            'GOOGLE_SHEETS_SERVICE_ACCOUNT_KEY_PATH is not set. ' +
              'See .env.example for setup instructions.',
          );
        }

        const raw = fs.readFileSync(path.resolve(keyPath), 'utf-8');
        return JSON.parse(raw);
      },
    }),
  ],
  controllers: [SheetsController],
  providers: [SheetsService],
  exports: [SheetsService],
})
export class SheetsModule {}
