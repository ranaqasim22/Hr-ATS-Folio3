import { Controller, Get, Query, Req, Res } from '@nestjs/common';
import { Request, Response } from 'express';
import { CalendarService } from './calendar.service';
import { CalendarEventDto } from './dto/calendar-event.dto';

@Controller('calendar')
export class CalendarController {
  constructor(private readonly calendarService: CalendarService) {}

  @Get('events')
  async getEvents(
    @Query('from') from: string,
    @Query('to') to: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const timeMin = from ? new Date(from) : undefined;
    const timeMax = to ? new Date(to) : undefined;

    const events: CalendarEventDto[] = await this.calendarService.getInterviewEvents(
      timeMin,
      timeMax,
    );

    const wantsHtml = (req.headers.accept || '').includes('text/html');
    const jsonText = JSON.stringify(events, null, 2);

    if (wantsHtml) {
      const REFRESH_SECONDS = 600;

      res.setHeader('Content-Type', 'text/html');
       res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
      return res.send(`<!DOCTYPE html>
<html>
<head>
  <meta http-equiv="refresh" content="${REFRESH_SECONDS}">
  <title>Calendar Events</title>
  <style>
    body { font-family: monospace; background: #fff; margin: 20px; }
    pre { white-space: pre-wrap; word-break: break-word; }
  </style>
</head>
<body>
<pre>${jsonText.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</pre>
</body>
</html>`);
    }

    return res.json(events);
  }
}
