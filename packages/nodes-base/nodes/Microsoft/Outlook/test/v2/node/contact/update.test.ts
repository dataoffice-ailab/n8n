import type { INodeTypes } from 'n8n-workflow';

import { executeWorkflow } from '@test/nodes/ExecuteWorkflow';
import { getResultNodeData, setup, workflowToTests } from '@test/nodes/Helpers';
import type { WorkflowTestData } from '@test/nodes/types';

import * as transport from '../../../../v2/transport';

jest.mock('../../../../v2/transport', () => {
	const originalModule = jest.requireActual('../../../../v2/transport');
	return {
		...originalModule,
		microsoftApiRequest: jest.fn(async function (method: string) {
			if (method === 'PATCH') {
				return {
					'@odata.context':
						"https://graph.microsoft.com/v1.0/$metadata#users('b834447b-6848-4af9-8390-d2259ce46b74')/contacts/$entity",
					'@odata.etag': 'W/"EQAAABYAAABZf4De/LkrSqpPI8eyjUmAAAFW3Bou"',
					id: 'AAMkADlhOTA0MTc5LWUwOTMtNDRkZS05NzE0LTNlYmI0ZWM5OWI5OABGAAAAAABPLqzvT6b9RLP0CKzHiJrRBwBZf4De-LkrSqpPI8eyjUmAAAAAAAEOAABZf4De-LkrSqpPI8eyjUmAAAFXBCQuAAA=',
					createdDateTime: '2023-09-04T08:48:39Z',
					lastModifiedDateTime: '2023-09-04T09:06:21Z',
					changeKey: 'EQAAABYAAABZf4De/LkrSqpPI8eyjUmAAAFW3Bou',
					categories: ['blue', 'green'],
					parentFolderId:
						'AAMkADlhOTA0MTc5LWUwOTMtNDRkZS05NzE0LTNlYmI0ZWM5OWI5OAAuAAAAAABPLqzvT6b9RLP0CKzHiJrRAQBZf4De-LkrSqpPI8eyjUmAAAAAAAEOAAA=',
					birthday: '1991-09-19T11:59:00Z',
					fileAs: '',
					displayName: 'Username',
					givenName: 'User',
					initials: null,
					middleName: null,
					nickName: null,
					surname: 'Name',
					title: 'Title',
					yomiGivenName: null,
					yomiSurname: null,
					yomiCompanyName: null,
					generation: null,
					imAddresses: [],
					jobTitle: null,
					companyName: 'Company',
					department: 'IT',
					officeLocation: null,
					profession: null,
					businessHomePage: null,
					assistantName: 'Assistant',
					manager: 'Manager',
					homePhones: [],
					mobilePhone: '',
					businessPhones: ['999000555777'],
					spouseName: '',
					personalNotes: '',
					children: [],
					emailAddresses: [],
					homeAddress: {},
					businessAddress: {
						street: 'Street',
						city: 'City',
						state: 'State',
						countryOrRegion: 'Country',
						postalCode: '777777',
					},
					otherAddress: {},
				};
			}
		}),
	};
});

describe('Test MicrosoftOutlookV2, contact => update', () => {
	const workflows = ['nodes/Microsoft/Outlook/test/v2/node/contact/update.workflow.json'];
	const tests = workflowToTests(workflows);
	const nodeTypes = setup(tests);

	const testNode = async (testData: WorkflowTestData, types: INodeTypes) => {
		const { result } = await executeWorkflow(testData, types);

		const resultNodeData = getResultNodeData(result, testData);

		resultNodeData.forEach(({ nodeName, resultData }) => {
			return expect(resultData).toEqual(testData.output.nodeData[nodeName]);
		});

		expect(transport.microsoftApiRequest).toHaveBeenCalledTimes(1);
		expect(transport.microsoftApiRequest).toHaveBeenCalledWith(
			'PATCH',
			'/contacts/AAMkADlhOTA0MTc5LWUwOTMtNDRkZS05NzE0LTNlYmI0ZWM5OWI5OABGAAAAAABPLqzvT6b9RLP0CKzHiJrRBwBZf4De-LkrSqpPI8eyjUmAAAAAAAEOAABZf4De-LkrSqpPI8eyjUmAAAFXBCQuAAA=',
			{
				businessAddress: {
					city: 'City',
					countryOrRegion: 'Country',
					postalCode: '777777',
					state: 'State',
					street: 'Street',
				},
				businessPhones: ['999000555777'],
				displayName: 'Username',
				manager: 'Manager',
			},
		);

		expect(result.finished).toEqual(true);
	};

	for (const testData of tests) {
		test(testData.description, async () => await testNode(testData, nodeTypes));
	}
});
