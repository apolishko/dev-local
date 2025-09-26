/* eslint-disable */
import fs from 'fs';
import path from 'path';
import axios from 'axios';
import { getLog } from '../src/util/util';
import { HEADERS } from '../src/api/types';
import * as dotenv from 'dotenv';

// Load environment variables [!!! DO NOT REMOVE !!!]
dotenv.config();

const SCHEMAS_DIR = path.join(__dirname, 'schemas');
const { EXT_BASE_URL } = process.env;
const log = getLog('load-schemas');

const headers = {
  'Content-Type': 'application/json',
  [HEADERS.TENANT_ID]: 'system',
  [HEADERS.USER_EMAIL]: 'schema-loader@test.com',
  [HEADERS.REQUEST_ID]: `schema-load-${Date.now()}`,
};

const readSchemas = () => {
  if (!fs.existsSync(SCHEMAS_DIR)) {
    log.error('Schemas directory not found:', SCHEMAS_DIR);
    process.exit(1);
  }

  const files = fs
    .readdirSync(SCHEMAS_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort();
  if (!files.length) {
    log.warn('No JSON schema files found');
    process.exit(0);
  }

  log.info(`Found ${files.length} files: ${files.join(', ')}`);
  return files.map((file) => ({
    file,
    schema: JSON.parse(fs.readFileSync(path.join(SCHEMAS_DIR, file), 'utf8')),
  }));
};

const loadSchema = async (file: string, schema: any) => {
  try {
    const { data } = await axios.post(`${EXT_BASE_URL}/schemas`, schema, { headers });
    log.info(`${file} -> ${data.type} (${data.id})`);
    return { file, status: 'success' as const, id: data.id, type: data.type };
  } catch (error: any) {
    const msg = error.response?.data?.message || error.response?.statusText || error.message;
    const status = error.response?.status
      ? `HTTP ${error.response.status}`
      : error.code === 'ECONNREFUSED'
        ? 'Connection refused'
        : 'Error';
    log.error(`${file}: ${status} - ${msg}`);
    return { file, status: 'error' as const, error: `${status}: ${msg}` };
  }
};

(async () => {
  const schemas = readSchemas();
  const results = await Promise.all(schemas.map(({ file, schema }) => loadSchema(file, schema)));
  const [successful, failed] = [
    results.filter((r) => r.status === 'success'),
    results.filter((r) => r.status === 'error'),
  ];

  log.info(`Loaded ${successful.length}/${results.length} schemas`);
  if (failed.length) {
    log.error(`Failed: ${failed.length}`);
    failed.forEach((r) => log.error(`  ${r.file}: ${r.error}`));
  }

  process.exit(failed.length ? 1 : 0);
})();
