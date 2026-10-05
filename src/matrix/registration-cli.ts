import { dump } from 'js-yaml';

import { loadConfig } from '../config.js';
import { buildRegistrationFile } from './registration.js';

// Prints the registration file Synapse loads for the harness. The url is the APISIX route that
// forwards application service calls to the matrix role.
const config = loadConfig({ ...process.env, HARNESS_ROLE: 'matrix' });
const url = process.env['MATRIX_APPSERVICE_URL'];
if (url === undefined || url.length === 0) {
	throw new Error('MATRIX_APPSERVICE_URL is required: the APISIX route Synapse pushes to');
}
process.stdout.write(dump(buildRegistrationFile(config, url)));
