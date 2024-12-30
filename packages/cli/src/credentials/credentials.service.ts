import type { Scope } from '@n8n/permissions';
// eslint-disable-next-line n8n-local-rules/misplaced-n8n-typeorm-import
import {
	In,
	type EntityManager,
	type FindOptionsRelations,
	type FindOptionsWhere,
} from '@n8n/typeorm';
import { Credentials, Logger } from 'n8n-core';
import type {
	ICredentialDataDecryptedObject,
	ICredentialsDecrypted,
	ICredentialType,
	INodeProperties,
} from 'n8n-workflow';
import { ApplicationError, CREDENTIAL_EMPTY_VALUE, deepCopy, NodeHelpers } from 'n8n-workflow';
import { Service } from 'typedi';

import { CREDENTIAL_BLANKING_VALUE } from '@/constants';
import { CredentialTypes } from '@/credential-types';
import { createCredentialsFromCredentialsEntity } from '@/credentials-helper';
import { CredentialsEntity } from '@/databases/entities/credentials-entity';
import type { ProjectRelation } from '@/databases/entities/project-relation';
import { SharedCredentials } from '@/databases/entities/shared-credentials';
import type { User } from '@/databases/entities/user';
import { CredentialsRepository } from '@/databases/repositories/credentials.repository';
import { ProjectRepository } from '@/databases/repositories/project.repository';
import { SharedCredentialsRepository } from '@/databases/repositories/shared-credentials.repository';
import { UserRepository } from '@/databases/repositories/user.repository';
import * as Db from '@/db';
import { BadRequestError } from '@/errors/response-errors/bad-request.error';
import { NotFoundError } from '@/errors/response-errors/not-found.error';
import { ExternalHooks } from '@/external-hooks';
import { validateEntity } from '@/generic-helpers';
import type { ICredentialsDb } from '@/interfaces';
import { userHasScopes } from '@/permissions.ee/check-access';
import type { CredentialRequest, ListQuery } from '@/requests';
import { CredentialsTester } from '@/services/credentials-tester.service';
import { OwnershipService } from '@/services/ownership.service';
import { ProjectService } from '@/services/project.service.ee';
import { RoleService } from '@/services/role.service';

export type CredentialsGetSharedOptions =
	| { allowGlobalScope: true; globalScope: Scope }
	| { allowGlobalScope: false };

@Service()
export class CredentialsService {
	constructor(
		private readonly credentialsRepository: CredentialsRepository,
		private readonly sharedCredentialsRepository: SharedCredentialsRepository,
		private readonly ownershipService: OwnershipService,
		private readonly logger: Logger,
		private readonly credentialsTester: CredentialsTester,
		private readonly externalHooks: ExternalHooks,
		private readonly credentialTypes: CredentialTypes,
		private readonly projectRepository: ProjectRepository,
		private readonly projectService: ProjectService,
		private readonly roleService: RoleService,
		private readonly userRepository: UserRepository,
	) {}

	async getMany(
		user: User,
		options: {
			listQueryOptions?: ListQuery.Options;
			includeScopes?: string;
		} = {},
	) {
		const returnAll = user.hasGlobalScope('credential:list');
		const isDefaultSelect = !options.listQueryOptions?.select;

		let projectRelations: ProjectRelation[] | undefined = undefined;
		if (options.includeScopes) {
			projectRelations = await this.projectService.getProjectRelationsForUser(user);
			if (options.listQueryOptions?.filter?.projectId && user.hasGlobalScope('credential:list')) {
				// Only instance owners and admins have the credential:list scope
				// Those users should be able to use _all_ credentials within their workflows.
				// TODO: Change this so we filter by `workflowId` in this case. Require a slight FE change
				const projectRelation = projectRelations.find(
					(relation) => relation.projectId === options.listQueryOptions?.filter?.projectId,
				);
				if (projectRelation?.role === 'project:personalOwner') {
					// Will not affect team projects as these have admins, not owners.
					delete options.listQueryOptions?.filter?.projectId;
				}
			}
		}

		if (returnAll) {
			let credentials = await this.credentialsRepository.findMany(options.listQueryOptions);

			if (isDefaultSelect) {
				// Since we're filtering using project ID as part of the relation,
				// we end up filtering out all the other relations, meaning that if
				// it's shared to a project, it won't be able to find the home project.
				// To solve this, we have to get all the relation now, even though
				// we're deleting them later.
				if ((options.listQueryOptions?.filter?.shared as { projectId?: string })?.projectId) {
					const relations = await this.sharedCredentialsRepository.getAllRelationsForCredentials(
						credentials.map((c) => c.id),
					);
					credentials.forEach((c) => {
						c.shared = relations.filter((r) => r.credentialsId === c.id);
					});
				}
				credentials = credentials.map((c) => this.ownershipService.addOwnedByAndSharedWith(c));
			}

			if (options.includeScopes) {
				credentials = credentials.map((c) =>
					this.roleService.addScopes(c, user, projectRelations!),
				);
			}

			return credentials;
		}

		// If the workflow is part of a personal project we want to show the credentials the user making the request has access to, not the credentials the user owning the workflow has access to.
		if (typeof options.listQueryOptions?.filter?.projectId === 'string') {
			const project = await this.projectService.getProject(
				options.listQueryOptions.filter.projectId,
			);
			if (project?.type === 'personal') {
				const currentUsersPersonalProject = await this.projectService.getPersonalProject(user);
				options.listQueryOptions.filter.projectId = currentUsersPersonalProject?.id;
			}
		}

		const ids = await this.sharedCredentialsRepository.getCredentialIdsByUserAndRole([user.id], {
			scopes: ['credential:read'],
		});

		let credentials = await this.credentialsRepository.findMany(
			options.listQueryOptions,
			ids, // only accessible credentials
		);

		if (isDefaultSelect) {
			// Since we're filtering using project ID as part of the relation,
			// we end up filtering out all the other relations, meaning that if
			// it's shared to a project, it won't be able to find the home project.
			// To solve this, we have to get all the relation now, even though
			// we're deleting them later.
			if ((options.listQueryOptions?.filter?.shared as { projectId?: string })?.projectId) {
				const relations = await this.sharedCredentialsRepository.getAllRelationsForCredentials(
					credentials.map((c) => c.id),
				);
				credentials.forEach((c) => {
					c.shared = relations.filter((r) => r.credentialsId === c.id);
				});
			}

			credentials = credentials.map((c) => this.ownershipService.addOwnedByAndSharedWith(c));
		}

		if (options.includeScopes) {
			credentials = credentials.map((c) => this.roleService.addScopes(c, user, projectRelations!));
		}

		return credentials;
	}

	/**
	 * @param user The user making the request
	 * @param options.workflowId The workflow that is being edited
	 * @param options.projectId The project owning the workflow This is useful
	 * for workflows that have not been saved yet.
	 */
	async getCredentialsAUserCanUseInAWorkflow(
		user: User,
		options: { workflowId: string } | { projectId: string },
	) {
		// necessary to get the scopes
		const projectRelations = await this.projectService.getProjectRelationsForUser(user);

		// get all credentials the user has access to
		const allCredentials = await this.credentialsRepository.findCredentialsForUser(user, [
			'credential:read',
		]);

		// get all credentials the workflow or project has access to
		const allCredentialsForWorkflow =
			'workflowId' in options
				? (await this.findAllCredentialIdsForWorkflow(options.workflowId)).map((c) => c.id)
				: (await this.findAllCredentialIdsForProject(options.projectId)).map((c) => c.id);

		// the intersection of both is all credentials the user can use in this
		// workflow or project
		const intersection = allCredentials.filter((c) => allCredentialsForWorkflow.includes(c.id));

		return intersection
			.map((c) => this.roleService.addScopes(c, user, projectRelations))
			.map((c) => ({
				id: c.id,
				name: c.name,
				type: c.type,
				scopes: c.scopes,
				isManaged: c.isManaged,
			}));
	}

	async findAllCredentialIdsForWorkflow(workflowId: string): Promise<CredentialsEntity[]> {
		// If the workflow is owned by a personal project and the owner of the
		// project has global read permissions it can use all personal credentials.
		const user = await this.userRepository.findPersonalOwnerForWorkflow(workflowId);
		if (user?.hasGlobalScope('credential:read')) {
			return await this.credentialsRepository.findAllPersonalCredentials();
		}

		// Otherwise the workflow can only use credentials from projects it's part
		// of.
		return await this.credentialsRepository.findAllCredentialsForWorkflow(workflowId);
	}

	async findAllCredentialIdsForProject(projectId: string): Promise<CredentialsEntity[]> {
		// If this is a personal project and the owner of the project has global
		// read permissions then all workflows in that project can use all
		// credentials of all personal projects.
		const user = await this.userRepository.findPersonalOwnerForProject(projectId);
		if (user?.hasGlobalScope('credential:read')) {
			return await this.credentialsRepository.findAllPersonalCredentials();
		}

		// Otherwise only the credentials in this project can be used.
		return await this.credentialsRepository.findAllCredentialsForProject(projectId);
	}

	/**
	 * Retrieve the sharing that matches a user and a credential.
	 */
	// TODO: move to SharedCredentialsService
	async getSharing(
		user: User,
		credentialId: string,
		globalScopes: Scope[],
		relations: FindOptionsRelations<SharedCredentials> = { credentials: true },
	): Promise<SharedCredentials | null> {
		let where: FindOptionsWhere<SharedCredentials> = { credentialsId: credentialId };

		if (!user.hasGlobalScope(globalScopes, { mode: 'allOf' })) {
			where = {
				...where,
				role: 'credential:owner',
				project: {
					projectRelations: {
						role: 'project:personalOwner',
						userId: user.id,
					},
				},
			};
		}

		return await this.sharedCredentialsRepository.findOne({
			where,
			relations,
		});
	}

	async prepareCreateData(
		data: CredentialRequest.CredentialProperties,
	): Promise<CredentialsEntity> {
		const { id, ...rest } = data;

		// This saves us a merge but requires some type casting. These
		// types are compatible for this case.
		const newCredentials = this.credentialsRepository.create(rest as ICredentialsDb);

		await validateEntity(newCredentials);

		return newCredentials;
	}

	async prepareUpdateData(
		data: CredentialRequest.CredentialProperties,
		decryptedData: ICredentialDataDecryptedObject,
	): Promise<CredentialsEntity> {
		const mergedData = deepCopy(data);
		if (mergedData.data) {
			mergedData.data = this.unredact(mergedData.data, decryptedData);
		}

		// This saves us a merge but requires some type casting. These
		// types are compatible for this case.
		const updateData = this.credentialsRepository.create(mergedData as ICredentialsDb);

		await validateEntity(updateData);

		// Do not overwrite the oauth data else data like the access or refresh token would get lost
		// every time anybody changes anything on the credentials even if it is just the name.
		if (decryptedData.oauthTokenData) {
			// @ts-ignore
			updateData.data.oauthTokenData = decryptedData.oauthTokenData;
		}
		return updateData;
	}

	createEncryptedData(credentialId: string | null, data: CredentialsEntity): ICredentialsDb {
		const credentials = new Credentials({ id: credentialId, name: data.name }, data.type);

		credentials.setData(data.data as unknown as ICredentialDataDecryptedObject);

		const newCredentialData = credentials.getDataToSave() as ICredentialsDb;

		// Add special database related data
		newCredentialData.updatedAt = new Date();

		return newCredentialData;
	}

	decrypt(credential: CredentialsEntity) {
		const coreCredential = createCredentialsFromCredentialsEntity(credential);
		return coreCredential.getData();
	}

	async update(credentialId: string, newCredentialData: ICredentialsDb) {
		await this.externalHooks.run('credentials.update', [newCredentialData]);

		// Update the credentials in DB
		await this.credentialsRepository.update(credentialId, newCredentialData);

		// We sadly get nothing back from "update". Neither if it updated a record
		// nor the new value. So query now the updated entry.
		return await this.credentialsRepository.findOneBy({ id: credentialId });
	}

	async save(
		credential: CredentialsEntity,
		encryptedData: ICredentialsDb,
		user: User,
		projectId?: string,
	) {
		// To avoid side effects
		const newCredential = new CredentialsEntity();
		Object.assign(newCredential, credential, encryptedData);

		await this.externalHooks.run('credentials.create', [encryptedData]);

		const result = await Db.transaction(async (transactionManager) => {
			const savedCredential = await transactionManager.save<CredentialsEntity>(newCredential);

			savedCredential.data = newCredential.data;

			const project =
				projectId === undefined
					? await this.projectRepository.getPersonalProjectForUserOrFail(
							user.id,
							transactionManager,
						)
					: await this.projectService.getProjectWithScope(
							user,
							projectId,
							['credential:create'],
							transactionManager,
						);

			if (typeof projectId === 'string' && project === null) {
				throw new BadRequestError(
					"You don't have the permissions to save the credential in this project.",
				);
			}

			// Safe guard in case the personal project does not exist for whatever reason.
			if (project === null) {
				throw new ApplicationError('No personal project found');
			}

			const newSharedCredential = this.sharedCredentialsRepository.create({
				role: 'credential:owner',
				credentials: savedCredential,
				projectId: project.id,
			});

			await transactionManager.save<SharedCredentials>(newSharedCredential);

			return savedCredential;
		});
		this.logger.debug('New credential created', {
			credentialId: newCredential.id,
			ownerId: user.id,
		});
		return result;
	}

	async delete(credentials: CredentialsEntity) {
		await this.externalHooks.run('credentials.delete', [credentials.id]);

		await this.credentialsRepository.remove(credentials);
	}

	async test(user: User, credentials: ICredentialsDecrypted) {
		return await this.credentialsTester.testCredentials(user, credentials.type, credentials);
	}

	// Take data and replace all sensitive values with a sentinel value.
	// This will replace password fields and oauth data.
	redact(data: ICredentialDataDecryptedObject, credential: CredentialsEntity) {
		const copiedData = deepCopy(data);

		let credType: ICredentialType;
		try {
			credType = this.credentialTypes.getByName(credential.type);
		} catch {
			// This _should_ only happen when testing. If it does happen in
			// production it means it's either a mangled credential or a
			// credential for a removed community node. Either way, there's
			// no way to know what to redact.
			return data;
		}

		const getExtendedProps = (type: ICredentialType) => {
			const props: INodeProperties[] = [];
			for (const e of type.extends ?? []) {
				const extendsType = this.credentialTypes.getByName(e);
				const extendedProps = getExtendedProps(extendsType);
				NodeHelpers.mergeNodeProperties(props, extendedProps);
			}
			NodeHelpers.mergeNodeProperties(props, type.properties);
			return props;
		};
		const properties = getExtendedProps(credType);

		for (const dataKey of Object.keys(copiedData)) {
			// The frontend only cares that this value isn't falsy.
			if (dataKey === 'oauthTokenData' || dataKey === 'csrfSecret') {
				if (copiedData[dataKey].toString().length > 0) {
					copiedData[dataKey] = CREDENTIAL_BLANKING_VALUE;
				} else {
					copiedData[dataKey] = CREDENTIAL_EMPTY_VALUE;
				}
				continue;
			}
			const prop = properties.find((v) => v.name === dataKey);
			if (!prop) {
				continue;
			}
			if (
				prop.typeOptions?.password &&
				(!(copiedData[dataKey] as string).startsWith('={{') || prop.noDataExpression)
			) {
				if (copiedData[dataKey].toString().length > 0) {
					copiedData[dataKey] = CREDENTIAL_BLANKING_VALUE;
				} else {
					copiedData[dataKey] = CREDENTIAL_EMPTY_VALUE;
				}
			}
		}

		return copiedData;
	}

	private unredactRestoreValues(unmerged: any, replacement: any) {
		// eslint-disable-next-line @typescript-eslint/no-unsafe-argument
		for (const [key, value] of Object.entries(unmerged)) {
			if (value === CREDENTIAL_BLANKING_VALUE || value === CREDENTIAL_EMPTY_VALUE) {
				// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
				unmerged[key] = replacement[key];
			} else if (
				typeof value === 'object' &&
				value !== null &&
				key in replacement &&
				// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
				typeof replacement[key] === 'object' &&
				// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
				replacement[key] !== null
			) {
				// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
				this.unredactRestoreValues(value, replacement[key]);
			}
		}
	}

	// Take unredacted data (probably from the DB) and merge it with
	// redacted data to create an unredacted version.
	unredact(
		redactedData: ICredentialDataDecryptedObject,
		savedData: ICredentialDataDecryptedObject,
	) {
		// Replace any blank sentinel values with their saved version
		const mergedData = deepCopy(redactedData);
		this.unredactRestoreValues(mergedData, savedData);
		return mergedData;
	}

	async getOne(user: User, credentialId: string, includeDecryptedData: boolean) {
		let sharing: SharedCredentials | null = null;
		let decryptedData: ICredentialDataDecryptedObject | null = null;

		sharing = includeDecryptedData
			? // Try to get the credential with `credential:update` scope, which
				// are required for decrypting the data.
				await this.getSharing(user, credentialId, [
					'credential:read',
					// TODO: Enable this once the scope exists and has been added to the
					// global:owner role.
					// 'credential:decrypt',
				])
			: null;

		if (sharing) {
			// Decrypt the data if we found the credential with the `credential:update`
			// scope.
			decryptedData = this.redact(this.decrypt(sharing.credentials), sharing.credentials);
		} else {
			// Otherwise try to find them with only the `credential:read` scope. In
			// that case we return them without the decrypted data.
			sharing = await this.getSharing(user, credentialId, ['credential:read']);
		}

		if (!sharing) {
			throw new NotFoundError(`Credential with ID "${credentialId}" could not be found.`);
		}

		const { credentials: credential } = sharing;

		const { data: _, ...rest } = credential;

		if (decryptedData) {
			return { data: decryptedData, ...rest };
		}
		return { ...rest };
	}

	async getCredentialScopes(user: User, credentialId: string): Promise<Scope[]> {
		const userProjectRelations = await this.projectService.getProjectRelationsForUser(user);
		const shared = await this.sharedCredentialsRepository.find({
			where: {
				projectId: In([...new Set(userProjectRelations.map((pr) => pr.projectId))]),
				credentialsId: credentialId,
			},
		});
		return this.roleService.combineResourceScopes('credential', user, shared, userProjectRelations);
	}

	/**
	 * Transfers all credentials owned by a project to another one.
	 * This has only been tested for personal projects. It may need to be amended
	 * for team projects.
	 **/
	async transferAll(fromProjectId: string, toProjectId: string, trx?: EntityManager) {
		trx = trx ?? this.credentialsRepository.manager;

		// Get all shared credentials for both projects.
		const allSharedCredentials = await trx.findBy(SharedCredentials, {
			projectId: In([fromProjectId, toProjectId]),
		});

		const sharedCredentialsOfFromProject = allSharedCredentials.filter(
			(sc) => sc.projectId === fromProjectId,
		);

		// For all credentials that the from-project owns transfer the ownership
		// to the to-project.
		// This will override whatever relationship the to-project already has to
		// the resources at the moment.
		const ownedCredentialIds = sharedCredentialsOfFromProject
			.filter((sc) => sc.role === 'credential:owner')
			.map((sc) => sc.credentialsId);

		await this.sharedCredentialsRepository.makeOwner(ownedCredentialIds, toProjectId, trx);

		// Delete the relationship to the from-project.
		await this.sharedCredentialsRepository.deleteByIds(ownedCredentialIds, fromProjectId, trx);

		// Transfer relationships that are not `credential:owner`.
		// This will NOT override whatever relationship the to-project already has
		// to the resource at the moment.
		const sharedCredentialIdsOfTransferee = allSharedCredentials
			.filter((sc) => sc.projectId === toProjectId)
			.map((sc) => sc.credentialsId);

		// All resources that are shared with the from-project, but not with the
		// to-project.
		const sharedCredentialsToTransfer = sharedCredentialsOfFromProject.filter(
			(sc) =>
				sc.role !== 'credential:owner' &&
				!sharedCredentialIdsOfTransferee.includes(sc.credentialsId),
		);

		await trx.insert(
			SharedCredentials,
			sharedCredentialsToTransfer.map((sc) => ({
				credentialsId: sc.credentialsId,
				projectId: toProjectId,
				role: sc.role,
			})),
		);
	}

	async replaceCredentialContentsForSharee(
		user: User,
		credential: CredentialsEntity,
		decryptedData: ICredentialDataDecryptedObject,
		mergedCredentials: ICredentialsDecrypted,
	) {
		// We may want to change this to 'credential:decrypt' if that gets added, but this
		// works for now. The only time we wouldn't want to do this is if the user
		// could actually be testing the credential before saving it, so this should cover
		// the cases we need it for.
		if (
			!(await userHasScopes(user, ['credential:update'], false, { credentialId: credential.id }))
		) {
			mergedCredentials.data = decryptedData;
		}
	}

	/**
	 * Create a new credential in user's account and return it along the scopes
	 * If a projectId is send, then it also binds the credential to that specific project
	 */
	async createCredential(credentialsData: CredentialRequest.CredentialProperties, user: User) {
		const newCredential = await this.prepareCreateData(credentialsData);

		const encryptedData = this.createEncryptedData(null, newCredential);

		const { shared, ...credential } = await this.save(
			newCredential,
			encryptedData,
			user,
			credentialsData.projectId,
		);

		const scopes = await this.getCredentialScopes(user, credential.id);

		return { ...credential, scopes };
	}
}
