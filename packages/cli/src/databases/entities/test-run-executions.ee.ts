import { Column, Entity, ManyToOne, OneToOne } from '@n8n/typeorm';

import {
	datetimeColumnType,
	jsonColumnType,
	WithStringId,
} from '@/databases/entities/abstract-entity';
import type { ExecutionEntity } from '@/databases/entities/execution-entity';
import { TestRun } from '@/databases/entities/test-run.ee';

/**
 * This entity represents the junction table between the test runs and executions
 */
@Entity({ name: 'test_run_executions' })
export class TestRunExecutionMapping extends WithStringId {
	@ManyToOne('TestRun')
	testRun: TestRun;

	@ManyToOne('ExecutionEntity', {
		onDelete: 'SET NULL',
		nullable: true,
	})
	pastExecution: ExecutionEntity | null;

	@OneToOne('ExecutionEntity', {
		onDelete: 'SET NULL',
		nullable: true,
	})
	execution: ExecutionEntity | null;

	@OneToOne('ExecutionEntity', {
		onDelete: 'SET NULL',
		nullable: true,
	})
	evaluationExecution: ExecutionEntity | null;

	@Column()
	status: string;

	@Column({ type: datetimeColumnType, nullable: true })
	runAt: Date | null;

	@Column({ type: datetimeColumnType, nullable: true })
	completedAt: Date | null;

	@Column('varchar', { nullable: true })
	errorCode: string | null;

	@Column(jsonColumnType, { nullable: true })
	errorDetails: Record<string, unknown>;
}
