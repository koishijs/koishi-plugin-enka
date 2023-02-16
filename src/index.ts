import { Context, segment } from 'koishi-core';
import type { HTTPResponse, Page } from 'puppeteer-core';
import sharp from 'sharp';

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function apply(ctx: Context) {
    let page: Page;
    let lock: Promise<void>;

    ctx.command('enka <search:string>')
        .alias('原')
        .userFields(['genshin_uid'])
        .action(async ({ session }, search) => {
            // TODO convert character name
            if (!session.user.genshin_uid) return '请先使用 genshin [uid] 绑定账号。';
            if (!page) page = await ctx.puppeteer.page();
            if (lock) await lock;
            let resolve: () => void;
            lock = new Promise((r) => { resolve = r; });
            try {
                await page.goto(`https://enka.network/u/${session.user.genshin_uid}/`, {
                    waitUntil: 'networkidle0',
                    timeout: 60000,
                });
                const { left, top } = await page.evaluate(async (search) => {
                    Array.from(document.querySelectorAll('.UI.SelectorElement')).find(i => i.innerHTML.trim() === '简体中文').click();
                    Array.from(document.querySelectorAll('.Dropdown-list')).map(i => i.style.display = 'none');
                    const tabs = Array.from(document.getElementsByTagName('figure'));
                    const select = tabs.find(i => i.style.backgroundImage?.toLowerCase().includes(search));
                    if (!select) return { left: 0, top: 0 };
                    const rect = select.parentElement.getBoundingClientRect();
                    Array.from(document.querySelectorAll('.Checkbox.Control.sm:not(.checked)')).map(i => i.click());
                    return { left: rect.left, top: rect.top };
                }, search.toLowerCase());
                if (!left) return '没有在玩家的角色展柜中找到该角色。';
                await page.mouse.click(left + 1, top + 1);
                await Promise.all([
                    page.waitForNetworkIdle({ idleTime: 100 }),
                    page.evaluate(() => {
                        const input = document.querySelector('[placeholder="自定义文本"]') as HTMLInputElement
                            || document.querySelector('[placeholder="Custom text"]') as HTMLInputElement;
                        input.value = 'HydroBot & Enka Network';
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
                const img = await sharp(buf).jpeg().toBuffer();
                return segment.image(`base64://${img.toString('base64')}`);
            } catch (error) {
                console.error(error);
                return '无法查看。'
            } finally {
                resolve();
            }
        })
}