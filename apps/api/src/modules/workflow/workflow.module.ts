import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ApproverResolver } from './approver-resolver.service';
import { InboxController } from './inbox.controller';
import { InboxService } from './inbox.service';
import { OutOfOfficeController } from './out-of-office.controller';
import { OutOfOfficeService } from './out-of-office.service';
import { WorkflowPeopleService } from './people.service';
import { WorkflowSubjectRegistry } from './subject-registry';
import { WorkflowAccessService } from './workflow-access.service';
import { WorkflowEngine } from './workflow-engine.service';
import { WorkflowHistoryService } from './workflow-history.service';
import { WorkflowJobs } from './workflow-jobs.service';
import { WorkflowNotifier } from './workflow-notifier.service';
import { WorkflowController } from './workflow.controller';

/**
 * The workflow engine (section 7), the inbox (5.10), out of office (5.11) and workflow
 * notifications (6). Feature modules import this module, inject `WorkflowEngine` to start
 * processes and `WorkflowSubjectRegistry` to register their subject handler.
 */
@Module({
  imports: [AuthModule],
  controllers: [WorkflowController, InboxController, OutOfOfficeController],
  providers: [
    WorkflowSubjectRegistry,
    WorkflowPeopleService,
    WorkflowAccessService,
    ApproverResolver,
    OutOfOfficeService,
    WorkflowEngine,
    WorkflowHistoryService,
    InboxService,
    WorkflowJobs,
    WorkflowNotifier,
  ],
  exports: [
    WorkflowEngine,
    WorkflowSubjectRegistry,
    WorkflowHistoryService,
    WorkflowAccessService,
    WorkflowPeopleService,
    OutOfOfficeService,
    WorkflowJobs,
  ],
})
export class WorkflowModule {}
