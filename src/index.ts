import { Argv, Context, Schema, h } from 'koishi';
import { } from 'koishi-plugin-puppeteer';
import { } from '@koishijs/cache';
import type { HTTPResponse, Page } from 'puppeteer-core';
import map from './map.json';
import localeMap from './locales/localeMap.json';

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

export const using = ['puppeteer']

export interface Config {
    maxAge: number
    // reverseProxy: string
}

export const Config: Schema<Config> = Schema.object({
    maxAge: Schema.number().min(0).max(9000000).default(0).step(1).description('cache 最大时间（毫秒，低于 30000 时为不缓存）'),
    // reverseProxy: Schema.string().role('link').description('加速代理地址（不是梯子）')
})

Argv.createDomain('UID', source => {
    if (/^[1256789][0-9]{3,9}$/gm.test(source))
        return source
    else
        throw new Error(`"${source}"不是一个正确的uid`)
})

export function apply(ctx: Context, config: Config) {
    ctx.i18n.define('zh', require('./locales/zh.yml'))
    ctx.model.extend('user', { genshin_uid: 'string(20)' })
    const logger = ctx.logger('enka')

    let page: Page;
    let lock: Promise<void>;
    let mapIndex: Record<string, string> = {};
    let cache;

    ctx.using(['cache'], () => { cache = ctx.cache('enka') })

    ctx.command('enka [search:string]')
        .alias('原')
        .userFields(['genshin_uid', 'locale'])
        .action(async ({ session }, search) => {
            const userLang: string[] = localeMap[session.user.locale] || ["简体中文", "自定义文本"]
            //characeter map indexing
            if (Object.keys(mapIndex).length <= 0) {
                for (let key in map) {
                    const character = map[key];
                    character['nikename'].forEach(name => {
                        mapIndex[name] = key;
                    });
                }
            }
            if (!session.user.genshin_uid) return session.text('.bind');
            if (search && !mapIndex[search]) return session.text('.non-existent');
            else search = mapIndex[search];

            await session.send(session.text('.relax'));
            const cacheKey = `enka_u${session.user.genshin_uid}_${search}`;
            //擦车
            if (cache && config.maxAge >= 30000) {
                const cacheValue = await cache.get(cacheKey);
                if (cacheValue) return h.image(Buffer.from(cacheValue, 'base64').buffer, 'image/png');
            }
            if (!page) page = await ctx.puppeteer.page();
            if (lock) await lock;
            let resolve: () => void;
            lock = new Promise((r) => { resolve = r; });
            try {
                await page.goto(`https://enka.network/u/${session.user.genshin_uid}/`, {
                    waitUntil: 'networkidle0',
                    timeout: 60000,
                });
                const { tabs, list } = await page.evaluate(async () => {
                    const tabs = Array.from<HTMLElement>(document.getElementsByTagName('figure'));
                    let _characters: string[] = []
                    tabs.forEach(ele => {
                        if (ele.style.backgroundImage?.includes('AvatarIcon')) {
                            _characters.push(ele.style.backgroundImage?.replace('url("/ui/UI_AvatarIcon_Side_', '').replace('.png")', ''))
                        }
                    })
                    return { tabs, list: _characters }
                })
                if (search) {
                    const { left, top } = await page.evaluate(async (tabs, search, userLang) => {
                        Array.from<HTMLElement>((document.querySelectorAll('.UI.SelectorElement'))).find(i => i.innerHTML.trim() === userLang).click();
                        Array.from<HTMLElement>((document.querySelectorAll('.Dropdown-list'))).map(i => i.style.display = 'none');
                        const select = tabs.find(i => i.style.backgroundImage?.toLowerCase().includes(search));
                        if (!select) return { left: 0, top: 0 };
                        const rect = select.parentElement.getBoundingClientRect();
                        Array.from<HTMLElement>((document.querySelectorAll('.Checkbox.Control.sm:not(.checked)'))).map(i => i.click());
                        return { left: rect.left, top: rect.top };
                    }, tabs, search.toLowerCase(), userLang[0]);
                    if (!left) return session.text('.not-found');
                    await page.mouse.click(left + 1, top + 1);
                    await Promise.all([
                        page.waitForNetworkIdle({ idleTime: 100 }),
                        page.evaluate((inText) => {
                            const input = document.querySelector(`[placeholder="${inText || 'Custom text'}"]`) as HTMLInputElement;
                            input.value = 'Koishi & Enka Network';
                            input.dispatchEvent(new Event('input'));
                        }, userLang[1]),
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
                    if (cache && config.maxAge >= 30000) await cache.set(cacheKey, buf.toString('base64'), config.maxAge);
                    return h.image(buf, 'image/png');
                } else {
                    let msg = `<p>${session.text('.list')}</p>`
                    if (list.length > 0) {
                        list.forEach(character => {
                            if(character.includes('Costume'))
                                character = character.split('Costume')[0]
                            msg += `<p>${character}</p>`
                        })
                    } else {
                        msg = session.text('.non-list')
                    }
                    return msg
                }
            } catch (error) {
                logger.error(error);
                return session.text('.error')
            } finally {
                resolve();
            }
        })
        .subcommand('.uid <uid:UID>')
        .userFields(['genshin_uid'])
        .action(async ({ session }, uid) => {
            session.user.genshin_uid = uid
            session.send(session.text('.saved', [uid]))
        })
}