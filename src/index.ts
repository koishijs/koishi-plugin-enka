import { Argv, Context, Schema, h } from 'koishi';
import { } from 'koishi-plugin-puppeteer';
import { } from '@koishijs/cache';
import type { HTTPResponse, Page } from 'puppeteer-core';
import useProxy from 'puppeteer-page-proxy';
import map from './map.json';
import localeMap from './locales/localeMap.json';

const UUIDRegExp = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

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

type AgentConfig = 'value' | 'miaoToken' | 'token'

export interface Config {
    agent: string | Record<AgentConfig, any>
    proxy: boolean | string
}

export const Config: Schema<Config> = Schema.object({
    agent: Schema.union([
        Schema.const('https://enka.network').description('Default(Enka)'),
        Schema.const('https://enka.network').description('占个位'),
        // Schema.object({
        //     value: Schema.const('https://api.nyan.zone/v1/genshin/player'),
        //     token: Schema.string().description('<a href="https://paimon-display.app.lonay.me">Luna.Y Token</a>').required()
        // }).description('Lipraty'),
        // Schema.object({
        //     value: Schema.const('http://miaoapi.cn'),
        //     miaoToken: Schema.string().description('喵喵API Token').required()
        // }).description('MiaoApi （未实装）'),
    ]).default('https://enka.network').description('请求地址') as Schema<string | Record<AgentConfig, any>>,
    proxy: Schema.union([
        Schema.const(false).description('Disable'),
        Schema.const(true).description('Root'),
        Schema.string().role('link').description('Self'),
    ]).description('代理设置（⚠实验性）')
})

Argv.createDomain('UID', source => {
    if (/^[1256789][0-9]{3,9}$/gm.test(source))
        return source
    else
        throw new Error(`"${source}"不是一个正确的uid`)
})

export function apply(ctx: Context, config: Config) {
    ctx.i18n.define('zh', require('./locales/zh'))
    ctx.model.extend('user', { genshin_uid: 'string(20)' })
    const logger = ctx.logger('enka')

    let page: Page;
    let lock: Promise<void>;
    let mapIndex: Record<string, string> = {};

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
            if (!page) page = await ctx.puppeteer.page();
            if (lock) await lock;
            let resolve: () => void;
            lock = new Promise((r) => { resolve = r; });
            try {
                if (config.proxy) await useProxy(page, config.proxy === true ? ctx.root.config.request.proxyAgent : config.proxy)
                await page.goto(`${config.agent}/u/${session.user.genshin_uid}/`, {
                    waitUntil: 'networkidle0',
                    timeout: 60000,
                });
                const { left, top, list } = await page.evaluate(async (search, userLang) => {
                    Array.from<HTMLElement>((document.querySelectorAll('.UI.SelectorElement'))).find(i => i.innerHTML.trim() === userLang).click();
                    Array.from<HTMLElement>((document.querySelectorAll('.Dropdown-list'))).map(i => i.style.display = 'none');
                    const tabs = Array.from<HTMLElement>(document.getElementsByTagName('figure'));
                    let _characters: string[] = []
                    tabs.forEach(ele => {
                        if (ele.style.backgroundImage?.includes('AvatarIcon')) {
                            _characters.push(ele.style.backgroundImage?.replace('url("/ui/UI_AvatarIcon_Side_', '').replace('.png")', ''))
                        }
                    })
                    if (search) {
                        const select = tabs.find(i => i.style.backgroundImage?.toLowerCase().includes(search.toLowerCase()));
                        const rect = select.parentElement.getBoundingClientRect();
                        Array.from<HTMLElement>((document.querySelectorAll('.Checkbox.Control.sm:not(.checked)'))).map(i => i.click());
                        if (!select) return { left: 0, top: 0, list: [] };
                        return { left: rect.left, top: rect.top, list: [] };
                    } else {
                        return { left: 0, top: 0, list: _characters }
                    }
                }, search, userLang[0])
                if (search) {
                    if (!left) return session.text('.not-found');
                    await page.mouse.click(left + 1, top + 1);
                    await Promise.all([
                        page.waitForNetworkIdle({ idleTime: 100 }),
                        page.evaluate((inText) => {
                            const input = document.querySelector<HTMLInputElement>(`[placeholder="${inText || 'Custom text'}"]`);
                            input.value = 'Koishi & Enka Network';
                            input.dispatchEvent(new Event('input'));
                        }, userLang[1]),
                    ]);
                    await page.click('button[data-icon="image"]');
                    const buf = await new Promise<Buffer>((resolve) => {
                        const cb = async (ev: HTTPResponse) => {
                            if (!UUIDRegExp.test(ev.request().url().trim())) return;
                            page.off('response', cb);
                            resolve(await ev.buffer());
                        };
                        page.on('response', cb);
                    });
                    return h.image(buf, 'image/png');
                } else {
                    let msg = `<p>${session.text('.list')}</p>`
                    if (list.length > 0) {
                        list.forEach(character => {
                            if (character.includes('Costume'))
                                character = character.split('Costume')[0]
                            if ((session.user.locale === 'zh' || !session.user.locale) && map[character.toLowerCase()]) character = map[character.toLowerCase()].cnName
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