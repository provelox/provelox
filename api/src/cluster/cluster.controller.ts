import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { z } from 'zod';
import { ValidationError } from '../common/errors';
import { ClusterService } from './cluster.service';

const change = z
  .object({
    availability: z.enum(['active', 'pause', 'drain']).optional(),
    role: z.enum(['worker', 'manager']).optional(),
  })
  .strict()
  .refine((c) => c.availability || c.role, 'Give an availability or a role.');

const rotate = z.object({ role: z.enum(['worker', 'manager']) }).strict();

/**
 * The machines of the cluster. Joining one gives it control of the Swarm and the Docker socket's reach, so none of
 * this is open to access tokens: only the signed-in admin.
 */
@Controller('system/cluster')
export class ClusterController {
  constructor(private readonly cluster: ClusterService) {}

  @Get()
  overview() {
    return this.cluster.overview();
  }

  @Get('join')
  join() {
    return this.cluster.joinInstructions();
  }

  @Post('join/rotate')
  rotate(@Body() body: unknown) {
    const p = rotate.safeParse(body);
    if (!p.success)
      throw new ValidationError('role must be worker or manager.');
    return this.cluster.rotateToken(p.data.role);
  }

  @Patch('nodes/:id')
  async update(@Param('id') id: string, @Body() body: unknown) {
    const p = change.safeParse(body);
    if (!p.success)
      throw new ValidationError(p.error.issues[0]?.message ?? 'Invalid change');
    // one change at a time keeps each refusal specific
    if (p.data.role) await this.cluster.setRole(id, p.data.role);
    if (p.data.availability)
      await this.cluster.setAvailability(id, p.data.availability);
    return this.cluster.overview();
  }

  @Delete('nodes/:id')
  async remove(@Param('id') id: string) {
    await this.cluster.remove(id);
    return this.cluster.overview();
  }
}
