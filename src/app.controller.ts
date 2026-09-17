import { Controller, Get } from '@nestjs/common';
import { TrackerService } from './tracker/tracker.service';

@Controller()
export class AppController {
  constructor(private readonly trackerService: TrackerService) {}

  @Get()
  getHello(): string {
    return 'Hello World!';
  }

  @Get('test-full-flow')
  async testFullFlow() {
    try {
      await this.trackerService.sync();
      return { message: 'Sync triggered successfully' };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { message: 'Failed', error: message };
    }
  }
}
