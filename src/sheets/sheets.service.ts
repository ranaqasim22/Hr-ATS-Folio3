import { Injectable } from '@nestjs/common';
import { GoogleSheetConnectorService } from '@icetee/nest-google-sheet-connector';
import { CalendarEventDto } from './dto/calendar-event.dto';

const SPREADSHEET_ID = process.env.GOOGLE_SHEET_ID as string;
const SHEET_NAME = process.env.GOOGLE_SHEET_NAME || 'Sheet1';
const EVENT_ID_COLUMN_INDEX = 12;
const DATA_RANGE = `${SHEET_NAME}!A:M`;

export interface SyncResult {
  action: 'created' | 'updated';
  rowIndex: number;
}

@Injectable()
export class SheetsService {
  constructor(private readonly sheetConnector: GoogleSheetConnectorService) {}
  private eventToRow(event: CalendarEventDto): any[] {
    return [
      event.candidateName ?? '',
      event.position ?? '',
      event.interviewStage ?? '',
      event.type ?? '',
      this.formatDate(event.date),
      event.time ?? '',
      event.location ?? '',
      event.interviewers ?? '',
      event.recruiter ?? '',
      event.contactNumber ?? '',
      event.emailAddress ?? '',
      event.resumeLink ?? '',
      event.eventId,
    ];
  }

  private formatDate(date: string | Date | undefined): string {
    if (!date) return '';

    const parsed = typeof date === 'string' ? new Date(date) : date;

    if (isNaN(parsed.getTime())) {
      return typeof date === 'string' ? date : '';
    }

    const day = String(parsed.getDate()).padStart(2, '0');
    const month = String(parsed.getMonth() + 1).padStart(2, '0');
    const year = parsed.getFullYear();

    return `${day}/${month}/${year}`;
  }

  async findRowByEventId(eventId: string): Promise<number | null> {
    const rows = await this.sheetConnector.readRange(SPREADSHEET_ID, DATA_RANGE);

    if (!rows) return null;

    const index = rows.findIndex(
      (row: any[], i: number) => i > 0 && row[EVENT_ID_COLUMN_INDEX] === eventId,
    );

    return index === -1 ? null : index + 1;
  }

  async appendRow(event: CalendarEventDto): Promise<void> {
    const row = this.eventToRow(event);
    await this.sheetConnector.addRow(SPREADSHEET_ID, DATA_RANGE, [row], 'USER_ENTERED');
  }

  async updateRow(rowIndex: number, event: CalendarEventDto): Promise<void> {
    const row = this.eventToRow(event);
    const range = `${SHEET_NAME}!A${rowIndex}:M${rowIndex}`;
    await this.sheetConnector.writeRange(SPREADSHEET_ID, range, [row], 'USER_ENTERED');
  }

  async syncEvent(event: CalendarEventDto): Promise<SyncResult> {
    if (!event.eventId) {
      throw new Error('eventId is required to sync an event to the sheet');
    }

    const existingRow = await this.findRowByEventId(event.eventId);

    if (existingRow) {
      await this.updateRow(existingRow, event);
      return { action: 'updated', rowIndex: existingRow };
    }

    await this.appendRow(event);
    const newRow = await this.findRowByEventId(event.eventId);

    return { action: 'created', rowIndex: newRow as number };
  }
}