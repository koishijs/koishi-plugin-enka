import { Argv, Context, Schema, h, pick } from 'koishi';
import type { HTTPResponse, Page } from 'puppeteer-core';
import { } from 'koishi-plugin-puppeteer';
import useProxy from 'puppeteer-page-proxy';
import fs from 'fs/promises';
import { EnkaAgent, EnkaApiData, EnkaCharacterData, EnkaDataAgent, ShowAvatarInfoList } from './types';
import localeMap from './locales/localeMap.json';
import path from 'path';


const UUIDRegExp = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

declare module 'koishi' {
    interface User {
        genshin_uid: string
        enka_data: EnkaData
    }
    interface Tables {
        enka_alias: EnkaAlias
    }
}

export const name = 'enka'

export const inject = ['puppeteer', 'database']

interface EnkaData {
    nickname: string
    level: number
    signature: string
    worldLevel: number
    characterList: number[]
    characterLevels: ShowAvatarInfoList[]
}

interface EnkaAlias {
    cid: string
    alias: string[]
}

export interface Config {
    agent: EnkaAgent
    data: EnkaDataAgent
    proxy: boolean | string
}

export const Config: Schema<Config> = Schema.object({
    agent: Schema.union([
        Schema.const(EnkaAgent.ENKA).description('默认(Enka)'),
        Schema.const(EnkaAgent.ENKA).description('默认(Enka)'),
    ]).default(EnkaAgent.ENKA).description('请求地址'),
    data: Schema.union([
        Schema.const(EnkaDataAgent.NYAN).description('NyanZone'),
        Schema.const(EnkaDataAgent.GITHUB).description('GitHub'),
        Schema.const(EnkaDataAgent.GHPROXY).description('Proxy(GH)')
    ]).default(EnkaDataAgent.NYAN).description('数据地址'),
    proxy: Schema.union([
        Schema.const(false).description('禁止'),
        Schema.const(true).description('全局设置'),
        Schema.string().role('link').description('自定义'),
    ]).description('Puppetter 代理设置，仅用于 Puppeteer, 不会影响其他请求（⚠实验性）')
})

// Argv.createDomain('UID', source => {
//     if (/^[1256789][0-9]{3,9}$/gm.test(source))
//         return source
//     else
//         throw new Error(`"${source}"不是一个正确的uid`)
// })

function mapIndexSearch(index: Record<string, string>, search: string) {
    for (let key in index) {
        if (key.includes(search)) return index[key]
    }
    return false
}

export function apply(ctx: Context, config: Config) {
    ctx.i18n.define('zh', require('./locales/zh'))
    ctx.model.extend('user', {
        genshin_uid: 'string(20)',
        enka_data: 'json'
    })
    ctx.model.extend('enka_alias', {
        cid: 'string(20)',
        alias: 'list'
    }, {
        primary: ['cid'],
        unique: ['cid']
    })
    const logger = ctx.logger('enka')

    let page: Page;
    let lock: Promise<void>;
    let mapIndex: Record<string, string> = {};
    let map: Record<string, any> = {};
    let characterInfo: EnkaCharacterData = {};

    async function initlization(forcibly: boolean = false) {
        logger.debug('checking characters data...');
        const dataPath = path.join(ctx.root.baseDir, 'data/enka/idMap.json');
        const characterPath = path.join(ctx.root.baseDir, 'data/enka/characters.json');
        const aliasData = await ctx.database.get('enka_alias', {})
        const update = async () => {
            if (forcibly) logger.debug('forcibly update characters data...');
            // download UIGF characters data
            logger.debug('downloading UIGF ID map...');
            const data = await ctx.http.get('https://api.uigf.org/dict/genshin/all.json');
            for (let locale in data) {
                locale = locale.toLowerCase();
                const characters = data[locale];
                if (locale === 'chs') locale = 'zh';
                if (locale === 'cht') locale = 'zh-tw';
                for (let name in characters) {
                    const id: number = characters[name];
                    if (id < 10000000) continue;
                    if (!map[id]) map[id] = { names: { [locale]: name } }
                    else map[id].names[locale] = name;
                }
            }
            // download enka characters data
            logger.debug('downloading characters data...');
            const enka = await ctx.http.get<Record<string, string>>(`${config.data}/characters.json`);
            await fs.mkdir('data/enka', { recursive: true });
            await fs.writeFile(characterPath, JSON.stringify(enka));
            await fs.writeFile(dataPath, JSON.stringify(map));
        }
        if (forcibly) await update();
        else {
            try {
                await fs.access(dataPath);
                await fs.access(characterPath);
                // load UIGF ID and Characters data
                logger.debug('characters data exists, loading...');
                const mapBuf = await fs.readFile(dataPath);
                const dataBuf = await fs.readFile(characterPath);
                map = JSON.parse(mapBuf.toString());
                characterInfo = JSON.parse(dataBuf.toString());
            } catch (error) {
                logger.debug('characters data not exists, mapping...');
                await update();
            }
        }
        for (let id in map) {
            const alias = aliasData.find(i => i.cid === id)?.alias || []
            mapIndex[[Object.values(map[id].names), ...alias].join(',')] = id; // '凯特,凱特,Kate,...': 10000001
        }
        logger.info('characters data loaded.')
    }

    ctx.on('ready', async () => {
        if (!page) page = await ctx.puppeteer.page();
        if (config.proxy) await useProxy(page, config.proxy === true ? ctx.root.config.request.proxyAgent : config.proxy);
        logger.info('initlizing puppeteer.');
        await initlization();
        logger.debug('all initlized.');
    });

    ctx.command('enka [search:string]')
        .userFields(['genshin_uid', 'locales', 'enka_data'])
        .option('update', '-u')
        .action(async ({ session, options }, search) => {
            const locale = ((session.user as any).locale || session.user.locales[0]) ?? 'zh'
            const userLang: string[] = localeMap[locale] || ["简体中文", "自定义文本"]
            logger.debug('search:', search)
            if (!session.user.genshin_uid) return session.text('.bind');
            if (search && !mapIndexSearch(mapIndex, search)) return session.text('.non-existent');
            else search = mapIndexSearch(mapIndex, search) as string;
            logger.debug('search to id:', search || 'null')
            logger.debug('userLang:', userLang)

            if (Object.keys(session.user.enka_data).length === 0 || options.update) {
                const info = (await ctx.http.get<EnkaApiData>(`${config.agent}/api/uid/${session.user.genshin_uid}`)).playerInfo;
                logger.debug('getting info:', info)
                if (info)
                    session.user.enka_data = {
                        characterList: info.showAvatarInfoList.map(i => i.avatarId),
                        characterLevels: info.showAvatarInfoList,
                        ...pick(info, ['nickname', 'level', 'signature', 'worldLevel'])
                    };
            }

            // now, the 'search' is a character id
            await session.send(session.text('.relax'));
            if (lock) await lock;
            let resolve: () => void;
            lock = new Promise((r) => { resolve = r; });
            if (search) {
                logger.debug('character:', characterInfo[search])
                if (!characterInfo[search]) return session.text('.non-existent');
                // check this search in user's character list
                if (!session.user.enka_data.characterList.includes(Number(search))) return session.text('.non-existent');
                // get character image
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
                                _characters.push(ele.style.backgroundImage?.replace('url("/ui/', '').replace('.png")', ''))
                            }
                        })
                        if (search) {
                            const select = tabs.find(i => i.style.backgroundImage?.toLowerCase().includes(search.SideIconName.toLowerCase()));
                            const rect = select.parentElement.getBoundingClientRect();
                            Array.from<HTMLElement>((document.querySelectorAll('.Checkbox.Control.sm:not(.checked)'))).map(i => i.click());
                            if (!select) return { left: 0, top: 0, list: [] };
                            return { left: rect.left, top: rect.top, list: [] };
                        } else {
                            return { left: 0, top: 0, list: _characters }
                        }
                    }, characterInfo[search], userLang[0])
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
                const { nickname, level, signature, worldLevel, characterLevels } = session.user.enka_data;
                logger.debug('user_data:', session.user.enka_data)
                let title = `<p>${session.text('.list', [nickname, level, signature, worldLevel])}</p>`
                const content: { namer: string, level: number }[] = []
                let tLength = 1
                logger.debug('characterLevels:', characterLevels)
                if (characterLevels.length > 0) {
                    characterLevels.forEach(character => {
                        const namer = map[character.avatarId]
                        if (character) {
                            const n = namer.names[locale || 'zh']
                            if (n.length > tLength) tLength = n.length
                            content.push({
                                namer: n, level: character.level
                            })
                        }
                    })
                } else {
                    title = session.text('.non-list')
                }
                resolve();
                return title + content.map(i => `<p>(${i.level.toString().padStart(2, '0')}) ${i.namer}</p>`).join('')
            }
        })

    ctx.command('enka.uid <uid:UID>')
        .userFields(['genshin_uid'])
        .action(async ({ session }, uid) => {
            if (!uid && !session.user.genshin_uid) return session.text('.bind')
            if (!uid) return session.text('.uid', [session.user.genshin_uid])
            if (uid === session.user.genshin_uid) return session.text('.same')
            session.user.genshin_uid = uid
            session.send(session.text('.saved', [uid]))
        })

    ctx.command('enka.upgrade')
        .alias('.up')
        .action(async ({ session }) => {
            session.send(session.text('.upgrading'))
            await initlization(true);
            return session.text('.upgraded')
        })

    ctx.command('enka.alias <name:string> <alias:string>')
        .action(async ({ session }, name, alias) => {
            const cid = mapIndexSearch(mapIndex, name)
            if (!cid) return session.text('.non-existent')
            const aliasTable = await ctx.database.get('enka_alias', { cid: cid })
            if (aliasTable.length === 0)
                aliasTable.push({ cid: cid, alias: [alias] })
            else {
                if (aliasTable[0].alias.includes(alias)) return session.text('.exist')
                aliasTable[0].alias.push(alias)
            }
            await ctx.database.upsert('enka_alias', aliasTable)
            initlization()
            return session.text('.saved', [alias, name])
        })
}