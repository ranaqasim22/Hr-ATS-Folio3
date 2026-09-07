import { Test, TestingModule } from '@nestjs/testing';
import { GoogleSheetConnectorService } from '@icetee/nest-google-sheet-connector';
import { SheetsService } from './sheets.service';
import { CalendarEventDto } from './dto/calendar-event.dto';

describe('SheetsService', () => {
  let service: SheetsService;
  let mockConnector: {
    readRange: jest.Mock;
    addRow: jest.Mock;
    writeRange: jest.Mock;
  };

  const mockEvent: CalendarEventDto = {
    candidateName: 'Test Candidate',
    position: 'Software Engineer',
    interviewStage: 'Technical Interview',
    type: 'Online',
    date: '05/09/2026',
    time: '03:00 PM',
    location: 'Google Meet',
    interviewers: 'John Doe',
    recruiter: 'HR Team',
    contactNumber: '03000000000',
    emailAddress: 'test@example.com',
    resumeLink: 'https://example.com/resume.pdf',
    eventId: 'test-event-001',
  };

  beforeEach(async () => {
    mockConnector = {
      readRange: jest.fn(),
      addRow: jest.fn(),
      writeRange: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SheetsService,
        { provide: GoogleSheetConnectorService, useValue: mockConnector },
      ],
    }).compile();

    service = module.get<SheetsService>(SheetsService);
  });

  it('Test 1: appends a new row when eventId does not exist', async () => {
    mockConnector.readRange
      .mockResolvedValueOnce([['header']])
      .mockResolvedValueOnce([['header'], [...Array(12).fill(''), 'test-event-001']]);

    const result = await service.syncEvent(mockEvent);

    expect(mockConnector.addRow).toHaveBeenCalledTimes(1);
    expect(mockConnector.writeRange).not.toHaveBeenCalled();
    expect(result.action).toBe('created');
    expect(result.rowIndex).toBe(2);
  });

  it('Test 2: updates the existing row when eventId already exists', async () => {
    mockConnector.readRange.mockResolvedValue([
      ['header'],
      [...Array(12).fill(''), 'test-event-001'],
    ]);

    const result = await service.syncEvent(mockEvent);

    expect(mockConnector.writeRange).toHaveBeenCalledTimes(1);
    expect(mockConnector.addRow).not.toHaveBeenCalled();
    expect(result.action).toBe('updated');
    expect(result.rowIndex).toBe(2);
  });

  it('Test 3: syncing the same eventId twice never creates a duplicate row', async () => {
    mockConnector.readRange.mockResolvedValue([
      ['header'],
      [...Array(12).fill(''), 'test-event-001'],
    ]);

    await service.syncEvent(mockEvent);
    await service.syncEvent(mockEvent);

    expect(mockConnector.addRow).not.toHaveBeenCalled();
    expect(mockConnector.writeRange).toHaveBeenCalledTimes(2);
  });

  it('Test 4: formats a Date object as dd/mm/yyyy before writing', async () => {
    mockConnector.readRange
      .mockResolvedValueOnce([['header']])
      .mockResolvedValueOnce([['header'], [...Array(12).fill(''), 'test-event-001']]);

    const eventWithDateObject: CalendarEventDto = {
      ...mockEvent,
      date: new Date(2026, 8, 5), // month is 0-indexed → September
    };

    await service.syncEvent(eventWithDateObject);

    const [, , rowsArg] = mockConnector.addRow.mock.calls[0];
    expect(rowsArg[0][4]).toBe('05/09/2026'); // date is column index 4
  });

  it('Test 5: missing optional fields do not crash the service', async () => {
    mockConnector.readRange
      .mockResolvedValueOnce([['header']])
      .mockResolvedValueOnce([['header'], [...Array(12).fill(''), 'minimal-event']]);

    const minimalEvent: CalendarEventDto = { eventId: 'minimal-event' };

    await expect(service.syncEvent(minimalEvent)).resolves.toBeDefined();
  });
});