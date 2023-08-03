import { Argv, Context, Schema, h, pick } from 'koishi';
import type { HTTPResponse, Page } from 'puppeteer-core';
import { } from 'koishi-plugin-puppeteer';
import useProxy from 'puppeteer-page-proxy';
import fs from 'fs/promises';
import { EnkaApiData } from './types';
import localeMap from './locales/localeMap.json';
import path from 'path';


const UUIDRegExp = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

declare module 'koishi' {
    interface User {
        genshin_uid: string
        enka_data: EnkaData
    }
    namespace Argv {
        interface Domain {
            UID: string
        }
    }
}

export const name = 'enka'

export const using = ['puppeteer']

type AgentConfig = 'value' | 'miaoToken' | 'token'

interface EnkaData {
    nickname: string
    level: number
    signature: string
    worldLevel: number
    characterList: number[]
}

export interface Config {
    agent: string | Record<AgentConfig, any>
    proxy: boolean | string
}

export const Config: Schema<Config> = Schema.object({
    agent: Schema.union([
        Schema.const('https://enka.network').description('Default(Enka)'),
    ]).default('https://enka.network').description('请求地址') as Schema<string | Record<AgentConfig, any>>,
    proxy: Schema.union([
        Schema.const(false).description('禁止'),
        Schema.const(true).description('全局设置'),
        Schema.string().role('link').description('自定义'),
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
    ctx.model.extend('user', {
        genshin_uid: 'string(20)',
        enka_data: 'json'
    })
    const logger = ctx.logger('enka')

    let page: Page;
    let lock: Promise<void>;
    let mapIndex: Record<string, string> = {};
    let map: Record<string, any> = {};

    function initlization() {
        logger.info('checking characters data...');
        const dataPath = path.join(ctx.root.baseDir, 'data/enka/characters.json');
        // check data file exists
        fs.access(dataPath).then(async () => {
            // load UIGF characters data
            const buf = await fs.readFile(dataPath);
            map = JSON.parse(buf.toString());
        }).catch(async () => {
            logger.info('characters data not exists, mapping...');
            // download UIGF characters data
            const data = await ctx.http.get('https://api.uigf.org/dict/genshin/all.json');
            for (let locale in data) {
                for (let name in data[locale]) {
                    const id = data[locale][name];
                    if (id < 10000001) continue;
                    if (locale === 'chs') locale = 'zh';
                    if (locale === 'cht') locale = 'zh-tw';
                    if (!map[id]) map[id] = { names: { [locale]: [name] } }
                    else map[id].names[locale] = [name];
                }
            }
            await fs.mkdir('data/enka', { recursive: true });
            await fs.writeFile(dataPath, JSON.stringify(map));
        });
        // load UIGF characters data
        logger.info('characters data loaded.');
        //characeter map indexing
        if (Object.keys(mapIndex).length <= 0) {
            for (let id in map) {
                const names = map[id].names;
                for (let locale in names) {
                    for (let name of names[locale]) {
                        mapIndex[name] = id;
                    }
                }
            }
        }
    }

    ctx.on('ready', async () => {
        if (!page) page = await ctx.puppeteer.page();
        if (config.proxy) await useProxy(page, config.proxy === true ? ctx.root.config.request.proxyAgent : config.proxy);
        logger.info('initlizing puppeteer...');
        initlization();
    });

    ctx.command('enka [search:string]')
        .userFields(['genshin_uid', 'locales', 'enka_data'])
        .action(async ({ session }, search) => {
            const locale = ((session.user as any).locale || session.user.locales[0]) ?? 'zh'
            const userLang: string[] = localeMap[locale] || ["简体中文", "自定义文本"]

            if (!session.user.genshin_uid) return session.text('.bind');
            if (search && !mapIndex[search]) return session.text('.non-existent');
            else search = mapIndex[search];

            await session.send(session.text('.relax'));
            if (lock) await lock;
            let resolve: () => void;
            lock = new Promise((r) => { resolve = r; });
            // save enka_data
            const info = (await ctx.http.get<EnkaApiData>(`${config.agent}/api/uid/${session.user.genshin_uid}`)).playerInfo;
            if (info)
                session.user.enka_data = {
                    characterList: info.showAvatarInfoList.map(i => i.avatarId),
                    ...pick(info, ['nickname', 'level', 'signature', 'worldLevel'])
                };
            if (search) {
                try {
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
                } catch (error) {
                    logger.error(error);
                    return session.text('.error')
                } finally {
                    resolve();
                }
            } else {
                const { nickname, level, signature, worldLevel, characterList } = session.user.enka_data;
                let msg = `<p>${session.text('.list', [nickname, level, signature, worldLevel])}</p>`
                if (characterList.length > 0) {
                    characterList.forEach(id => {
                        const character = map[id];
                        if (character) {
                            msg += `<p>${character.names[locale][0]}</p>`
                        }
                    })
                } else {
                    msg = session.text('.non-list')
                }
                return msg
            }
        })
        .subcommand('.uid <uid:UID>')
        .userFields(['genshin_uid'])
        .action(async ({ session }, uid) => {
            if (!uid && !session.user.genshin_uid) return session.text('.bind')
            if (!uid) return session.text('.uid', [session.user.genshin_uid])
            if (uid === session.user.genshin_uid) return session.text('.same')
            session.user.genshin_uid = uid
            session.send(session.text('.saved', [uid]))
        })
        .subcommand('.upgrade')
        .alias('.up')
        .action(async ({ session }) => {
            session.send(session.text('.upgrade'))
            initlization();
            return session.text('.upgraded')
        })
}