import { Controller, Get, Query } from '@nestjs/common';
import { CalendarService } from './calendar.service';
import { CalendarEventDto } from './dto/calendar-event.dto';

@Controller('calendar')
export class CalendarController {
  constructor(private readonly calendarService: CalendarService) {}

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
