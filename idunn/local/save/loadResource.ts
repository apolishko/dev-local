import type {
  OperationImplementationConfig,
  OperationImplementationResult,
} from 'platform/types/Services/OperationImplementation';
import type { BrowserOperationImplementation } from 'browser/types/BrowserOperationImplementation';
import type { RuntimeValue } from 'browser/types/RuntimeValue';
import type { OperationServices } from 'browser/types/OperationServices';
import type { AssetPreloadRequest, AssetURLArg } from 'browser/types/OperationServices/AssetPreloader';
import { addSerializationId } from '../../../browser/utils/serializeImage';
import type { InteroperationType} from '../../../types/InteroperationTypes/index';
import { InteroperationTypeNames } from '../../../types/InteroperationTypes/index';
import type { ResourceReference } from '../../../types/SourceGraph/Resource';

const loadResourceImplementation: BrowserOperationImplementation = {
  name: 'Load Resource',
  fn: loadResource,
  getAssetURLs: getAssetURLsImplementation,
};
export default loadResourceImplementation;

const interopTypes = Object.values(InteroperationTypeNames);

function isResourceTypeName(name: string): name is InteroperationTypeNames {
  return (interopTypes as string[]).includes(name);
}

// TODO: Add height and width to config to get exact resolution?
async function loadResource(
  services: OperationServices,
  config: OperationImplementationConfig,
  args: RuntimeValue[]
): Promise<OperationImplementationResult<RuntimeValue>> {
  if (args.length !== 3) throw new Error('Missing arguments');

  const [resourceType, ref, source] = args;
  if (typeof resourceType !== 'string' || typeof ref !== 'string' || typeof source !== 'string')
    throw new Error('Invalid arguments: resourceType, ref and source must be strings');
  if (!isResourceTypeName(resourceType)) throw new Error('Invalid arguments: resourceType');
  if (source !== 'generator' && source !== 'ams') throw new Error(`Invalid source: ${source}`);

  const resourceReference = source === 'generator'
    ? { resourceRef: ref }
    : { ams: ref };

  const resource = await services.resourceStorage.get(
    resourceReference,
    { type: resourceType } as InteroperationType,
    config.scalingFactor
  );
  if (!resource) throw new Error(
    `Resource '${ref}' of type '${resourceType}' from source '${source}' was not found in storage`
  );

  return addSerializationId({ outputs: [{ name: 'resource', value: resource }] }, 'Load Resource', args, config);
}

function getAssetURLsImplementation(config: OperationImplementationConfig, args: AssetURLArg[]): AssetPreloadRequest[] {
  if (args.length !== 3) return [];

  const [resourceType, ref, source] = args;
  if (typeof resourceType !== 'string' || typeof ref !== 'string' || typeof source !== 'string') return [];
  if (!isResourceTypeName(resourceType)) return [];
  if (source !== 'generator' && source !== 'ams') return [];

  // Browser AssetPreloader currently only supports generator resources
  // AMS resources will need to be handled differently in browser context
  if (source === 'ams') {
    // For now, return empty array for AMS resources in browser
    // TODO: Implement proper AMS resource preloading in browser
    return [];
  }

  return [{ resourceRef: ref, type: { type: InteroperationTypeNames[resourceType] } }];
}
