import { check } from '../core/types.js';
import { AdministratorClient } from '../administrator/client.js';
import { startAdministrator } from '../administrator/main.js';

/** Host has no Worker store or execution owner. It only forwards authenticated control. */
export function administratorControl(env, { client = null, startService = null } = {}) {
  let connection = client;
  const get = () => connection ||= new AdministratorClient({ env, startService: startService ?? (() => startAdministrator({ env })) });
  return async (operation, params, { userBinding, start = false }) => {
    check(start === (operation === 'preview'), 'administrator service startup requires an explicit user preview');
    const service = get();
    switch (operation) {
      case 'status': return service.readStatus();
      case 'list': return service.list(params);
      case 'detail': return service.detail(params);
      case 'receipt': return service.receipt(params, userBinding);
      case 'preview': return service.preview(params.definition, userBinding);
      case 'commit': return service.commit(params, userBinding);
      case 'stop': return service.stop(params.id, userBinding);
      default: throw new Error('unknown administrator control operation');
    }
  };
}
