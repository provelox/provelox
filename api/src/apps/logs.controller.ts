import { Controller, Get, Param, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { serviceName } from '../common/naming';
import { Inject } from '@nestjs/common';
import { DOCKER, type DockerPort } from '../docker/docker.port';
import type { LogLine } from '../utils/docker-log';
import { AppsService } from './apps.service';
import { Scope } from '../auth/scope.decorator';

const DEFAULT_TAIL = 200;
const MAX_TAIL = 1000;
const HEARTBEAT_MS = 15_000;

@Controller('apps/:name/logs')
export class LogsController {
  constructor(
    private readonly apps: AppsService,
    @Inject(DOCKER) private readonly docker: DockerPort,
  ) {}

  /**
   * The app's recent log lines as JSON, or with ?follow=1 a live Server-Sent Events stream of them
   * (one JSON line per event, a comment ping every 15 seconds to keep proxies from closing it).
   */
  @Scope('operate')
  @Get()
  async logs(
    @Param('name') name: string,
    @Query('tail') tailRaw: string | undefined,
    @Query('follow') follow: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    this.apps.getDefinition(name); // 404 before any stream starts
    const tail = Math.min(
      MAX_TAIL,
      Math.max(1, Number.parseInt(tailRaw ?? '', 10) || DEFAULT_TAIL),
    );
    const ctl = new AbortController();
    req.on('close', () => ctl.abort());

    if (follow !== '1') {
      const lines: LogLine[] = [];
      await this.docker.followLogs(
        serviceName(name),
        { tail, follow: false },
        (l) => lines.push(l),
        ctl.signal,
      );
      res.json(lines);
      return;
    }

    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no', // proxies must not buffer a live stream
    });
    res.flushHeaders();
    const ping = setInterval(() => res.write(': ping\n\n'), HEARTBEAT_MS);
    try {
      await this.docker.followLogs(
        serviceName(name),
        { tail, follow: true },
        (l) => res.write(`data: ${JSON.stringify(l)}\n\n`),
        ctl.signal,
      );
      if (!ctl.signal.aborted) res.write('event: end\ndata: {}\n\n');
    } finally {
      clearInterval(ping);
      res.end();
    }
  }
}
