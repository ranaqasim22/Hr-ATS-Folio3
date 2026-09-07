import { Body, Controller, Get, Post } from '@nestjs/common';
import { SheetsService, SyncResult } from './sheets.service';
import { CalendarEventDto } from '../calendar/dto/calendar-event.dto';
import { CalendarService } from '../calendar/calendar.service';

@Controller('sheets')
export class SheetsController {
  constructor(
    private readonly sheetsService: SheetsService,
    private readonly calendarService: CalendarService,
  ) {}

  
  @Post('sync')
  async sync(@Body() event: CalendarEventDto): Promise<SyncResult> {
    return this.sheetsService.syncEvent(event);
  }

  
  @Get('sync-from-calendar')
  async syncFromCalendar(): Promise<{ synced: SyncResult[]; count: number }> {
    const events = await this.calendarService.getInterviewEvents();
    const results: SyncResult[] = [];

    for (const event of events) {
      const result = await this.sheetsService.syncEvent(event);
      results.push(result);
    }

    return { synced: results, count: results.length };
  }
}