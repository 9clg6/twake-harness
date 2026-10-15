// A calendar the assistant may read and write: whether its owner is free, and a new meeting
export const MEETING_CATALOG = {
	openapi: '3.1.0',
	paths: {
		'/contracts/v1/calendar/freebusy': {
			get: {
				operationId: 'read_freebusy',
				summary: 'Tell whether the user is free over a period',
				tags: ['calendar.freebusy.read.v1'],
				parameters: [
					{ name: 'start', in: 'query', required: true, schema: { type: 'string' } },
					{ name: 'end', in: 'query', required: true, schema: { type: 'string' } }
				]
			}
		},
		'/contracts/v1/calendar/events': {
			post: {
				operationId: 'create_event',
				summary: "Create a meeting in the user's calendar",
				tags: ['calendar.events.create.v1'],
				'x-twake-risk': 'low',
				requestBody: {
					content: {
						'application/json': {
							schema: {
								type: 'object',
								properties: {
									title: { type: 'string' },
									start: { type: 'string', description: 'RFC 3339' },
									end: { type: 'string', description: 'RFC 3339' }
								},
								required: ['title', 'start', 'end']
							}
						}
					}
				}
			}
		}
	}
};

// The same calendar, with the owner's mail to search
export const MAIL_PATHS = {
	'/contracts/v1/mail/emails': {
		get: {
			operationId: 'search_emails',
			summary: "Searches the user's mail",
			tags: ['mail.emails.read.v1'],
			parameters: [{ name: 'from', in: 'query', required: false, schema: { type: 'string' } }]
		}
	}
};

// Contracts of other applications, which a message about the calendar asks for none of: a
// catalog the size of a real one, to tell what a model does among many tools
export const OTHER_PATHS = Object.fromEntries(
	[
		'tasks',
		'drive',
		'contacts',
		'notes',
		'chat',
		'forms',
		'polls',
		'wiki',
		'boards',
		'bookmarks'
	].flatMap((domain) => [
		[
			`/contracts/v1/${domain}/items`,
			{
				get: {
					operationId: `list_${domain}`,
					summary: `Lists the user's ${domain}`,
					tags: [`${domain}.items.read.v1`],
					parameters: []
				},
				post: {
					operationId: `create_${domain}_item`,
					summary: `Creates an item in the user's ${domain}`,
					tags: [`${domain}.items.create.v1`],
					'x-twake-risk': 'low',
					requestBody: {
						content: {
							'application/json': {
								schema: { type: 'object', properties: { title: { type: 'string' } } }
							}
						}
					}
				}
			}
		],
		[
			`/contracts/v1/${domain}/items/{id}`,
			{
				delete: {
					operationId: `delete_${domain}_item`,
					summary: `Deletes an item of the user's ${domain}`,
					tags: [`${domain}.items.delete.v1`],
					'x-twake-risk': 'low',
					parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }]
				}
			}
		]
	])
);
