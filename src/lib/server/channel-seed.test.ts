import { describe, expect, test } from 'bun:test';
import { seedChannels } from './channel-seed';
import type { AgentChannel } from './tuner';

const channel = (type: string) => ({ type, channel: `${type}1`, services: [] }) as unknown as AgentChannel;

describe('標準の表を入れるか', () => {
    /*
     * BS も CS もあれば、チューナーにも聞かずに帰る。局の一覧は1分ごとに読むので、
     * そのたびにエージェントへもう1本問い合わせることにならないように
     */
    test('BS も CS もあれば何もしない (チューナーにも聞かない)', async () => {
        expect(await seedChannels([channel('GR'), channel('BS'), channel('CS')])).toEqual([]);
    });
});
