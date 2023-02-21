import { Argv, Context, Schema, h } from 'koishi';
import { } from 'koishi-plugin-puppeteer';
import { } from '@koishijs/cache';
import type { HTTPResponse, Page } from 'puppeteer-core';
import map from './map.json'

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

declare module 'koishi' {
    interface User {
        genshin_uid: string
    }
    namespace Argv {
        interface Domain {
            UID: string
        }
    }
}

declare module '@koishijs/cache' {
    interface Tables {
        enka: string
    }
}

export const name = 'enka'

export const using = ['puppeteer', 'cache']

export const usage = `
## 插件说明

推荐（默认）设置缓存时间为角色展柜的刷新时间： 5 分钟。

> \`最大缓存时间\` 最小值为 6000(1m): enka.network 限制了查询时间为 1 分钟。
`

export interface Config {
    maxAge: number
    reverseProxy: string
}

export const Config: Schema<Config> = Schema.object({
    maxAge: Schema.number().min(60000).max(9000000).default(300000).step(1).description('图片缓存最大时间（毫秒）'),
    reverseProxy: Schema.string().role('link').description('加速代理地址（不是梯子）')
})

Argv.createDomain('UID', source => {
    if (/^[1256789][0-9]{3,9}$/gm.test(source))
        return source
    else
        throw new Error(`"${source}"不是一个正确的uid`)
})

export function apply(ctx: Context, config: Config) {
    let page: Page;
    let lock: Promise<void>;
    let mapIndex: Record<string, string> = {};

    ctx.model.extend('user', {
        genshin_uid: 'string(20)'
    })

    const cache = ctx.cache('enka');

    ctx.command('enka <search:string>')
        .alias('原')
        .userFields(['genshin_uid'])
        .action(async ({ session }, search) => {
            //indexing
            if (Object.keys(mapIndex).length <= 0) {
                for (let key in map) {
                    const character = map[key];
                    character['nikename'].forEach(name => {
                        mapIndex[name] = key;
                    });
                }
            }
            if (!session.user.genshin_uid) return '请先使用 enka.uid [uid] 绑定账号。';
            if (!mapIndex[search]) return '不存在该角色！';
            search = mapIndex[search]
            await session.send('别急，准备开查了！');
            const cacheKey = `enka_u${session.user.genshin_uid}_${search}`;
            const cacheValue = await cache.get(cacheKey);
            //cache
            if (cacheValue) return h.image(Buffer.from(cacheValue, 'base64').buffer, 'image/png');
            //
            if (!page) page = await ctx.puppeteer.page();
            if (lock) await lock;
            let resolve: () => void;
            lock = new Promise((r) => { resolve = r; });
            try {
                await page.goto(`${config.reverseProxy || 'https://enka.network'}/u/${session.user.genshin_uid}/`, {
                    waitUntil: 'networkidle0',
                    timeout: 60000,
                });
                const { left, top } = await page.evaluate(async (search) => {
                    Array.from((document.querySelectorAll('.UI.SelectorElement')) as NodeListOf<HTMLElement>).find(i => i.innerHTML.trim() === '简体中文').click();
                    Array.from((document.querySelectorAll('.Dropdown-list')) as NodeListOf<HTMLElement>).map(i => i.style.display = 'none');
                    const tabs = Array.from(document.getElementsByTagName('figure'));
                    const select = tabs.find(i => i.style.backgroundImage?.toLowerCase().includes(search));
                    if (!select) return { left: 0, top: 0 };
                    const rect = select.parentElement.getBoundingClientRect();
                    Array.from((document.querySelectorAll('.Checkbox.Control.sm:not(.checked)')) as NodeListOf<HTMLElement>).map(i => i.click());
                    return { left: rect.left, top: rect.top };
                }, search.toLowerCase());
                if (!left) return '没有在玩家的角色展柜中找到该角色。';
                await page.mouse.click(left + 1, top + 1);
                await Promise.all([
                    page.waitForNetworkIdle({ idleTime: 100 }),
                    page.evaluate(() => {
                        const input = document.querySelector('[placeholder="自定义文本"]') as HTMLInputElement
                            || document.querySelector('[placeholder="Custom text"]') as HTMLInputElement;
                        input.value = 'Koishi & Enka Network';
                        input.dispatchEvent(new Event('input'));
                    }),
                ]);
                await page.click('button[data-icon="image"]');
                const buf = await new Promise<Buffer>((resolve) => {
                    const cb = async (ev: HTTPResponse) => {
                        if (!UUID.test(ev.request().url().trim())) return;
                        page.off('response', cb);
                        resolve(await ev.buffer());
                    };
                    page.on('response', cb);
                });
                await cache.set(cacheKey, buf.toString('base64'), config.maxAge)
                return h.image(buf, 'image/png')
            } catch (error) {
                console.error(error);
                return '无法查看。'
            } finally {
                resolve();
            }
        })
        .subcommand('.uid <uid:UID>')
        .userFields(['genshin_uid'])
        .action(async ({ session }, uid) => {
            session.user.genshin_uid = uid
            session.send(`已保存你的 uid(${uid})`)
        })
}