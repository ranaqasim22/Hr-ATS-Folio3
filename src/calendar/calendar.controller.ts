import { Controller, Get, Query } from '@nestjs/common';
import { CalendarService } from './calendar.service';
import { CalendarEventDto } from './dto/calendar-event.dto';

@Controller('calendar')
export class CalendarController {
  constructor(private readonly calendarService: CalendarService) {}

  // GET /calendar/events?from=2026-09-01&to=2026-09-30
  // Manual test endpoint — lets you (and reviewers) verify the module
  // works without waiting for Member 4's cron job to be built.
  @Get('events')
  async getEvents(
    @Query('from') from?: string,
    @Query('to') to?: string,
  ): Promise<CalendarEventDto[]> {
    const timeMin = from ? new Date(from) : undefined;
    const timeMax = to ? new Date(to) : undefined;
    return this.calendarService.getInterviewEvents(timeMin, timeMax);
  }
}
