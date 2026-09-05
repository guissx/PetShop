import {chromium,expect} from '@playwright/test';
import {loadEnvFile} from 'node:process';
import assert from 'node:assert/strict';
loadEnvFile(new URL('../.env',import.meta.url));
const base=process.env.TEST_BASE_URL??'http://127.0.0.1:3000';
const browser=await chromium.launch({headless:true});
const page=await browser.newPage({viewport:{width:1440,height:1000},reducedMotion:'reduce'});
const errors=[];page.on('pageerror',e=>errors.push(e.message));
async function settled(){await page.locator('.content.is-pending').waitFor({state:'hidden'});await page.evaluate(()=>document.fonts.ready);}
async function popup(theme){
 const trigger=page.getByRole('combobox',{name:'Período',exact:true});const anchor=await trigger.boundingBox();const before=await page.locator('.content').boundingBox();await trigger.click();
 const menu=page.getByRole('listbox');await expect(menu).toBeVisible();
 await expect(menu).toBeInViewport();
 const during=await page.locator('.content').boundingBox();assert.ok(Math.abs(before.x-during.x)<1,'Opening a select must preserve horizontal position');assert.ok(Math.abs(before.width-during.width)<1,'Opening a select must preserve content width');
 await expect.poll(()=>menu.evaluate(el=>getComputedStyle(el).opacity)).toBe('1');
 await expect(page.getByRole('option')).toHaveCount(4);
 const box=await menu.boundingBox();assert.ok(Math.abs(box.width-anchor.width)<2);
 const colors=await page.getByRole('option').first().evaluate(el=>({color:getComputedStyle(el).color,background:getComputedStyle(el).backgroundColor}));assert.notEqual(colors.color,colors.background);
 await page.screenshot({path:`.artifacts/redesign-${theme}-select.png`});
 await page.keyboard.press('Escape');await expect(trigger).toBeFocused();
}
try{
 const login=await page.request.post(base+'/api/auth/login',{form:{username:process.env.DEMO_USERNAME,password:process.env.DEMO_PASSWORD},headers:{Origin:base}});assert.ok(login.ok());
 await page.goto(base);await page.getByRole('combobox',{name:'Ano',exact:true}).waitFor();await settled();
 await popup('light');
 await page.getByRole('button',{name:'Ativar tema escuro'}).click();
 await expect(page.locator('html')).toHaveAttribute('data-theme','dark');await popup('dark');
 await page.reload();await expect(page.locator('html')).toHaveAttribute('data-theme','dark');await settled();
 await page.getByRole('combobox',{name:'Ano',exact:true}).focus();await page.keyboard.press('Enter');await page.getByRole('listbox').waitFor();await page.keyboard.press('End');await expect(page.getByRole('option',{name:'2024',exact:true})).toBeFocused();await page.keyboard.press('Enter');await page.waitForURL(url=>url.searchParams.get('ano')==='2024');await settled();
 await page.emulateMedia({reducedMotion:'no-preference'});
 await page.goto(base+'/filiais?ano=2025&loja=0');await settled();
 const map=page.locator('.geo-map');await expect(map).toBeVisible();await page.waitForLoadState('networkidle');await map.scrollIntoViewIfNeeded();
 const initial=await map.getAttribute('viewBox');
 const scrollBefore=await page.evaluate(()=>scrollY);
 await page.getByRole('button',{name:'Ver filial Itabuna',exact:true}).click();
 await expect.poll(()=>map.getAttribute('viewBox')).not.toBe(initial);
 const middle=await map.getAttribute('viewBox');
 await expect.poll(async()=>Number((await map.getAttribute('viewBox')).split(/\s+/)[2]),{timeout:5000}).toBe(260);
 assert.notEqual(middle,await map.getAttribute('viewBox'));
 await settled();assert.ok(Math.abs(await page.evaluate(()=>scrollY)-scrollBefore)<2,'Selecting a city must preserve scroll');await page.screenshot({path:'.artifacts/redesign-dark-map.png',fullPage:true});
 await page.getByRole('button',{name:'Visão estadual',exact:true}).click();
 await expect.poll(()=>map.getAttribute('viewBox'),{timeout:5000}).toBe(initial);await settled();
 await page.screenshot({path:'.artifacts/redesign-dark-state.png',fullPage:true});
 await page.emulateMedia({reducedMotion:'reduce'});
 await page.reload();await expect(map).toBeVisible();await page.waitForLoadState('networkidle');
 await page.getByRole('button',{name:'Ver filial Salvador',exact:true}).focus();await page.keyboard.press('Enter');
 await expect.poll(async()=>Number((await map.getAttribute('viewBox')).split(/\s+/)[2]),{timeout:1000}).toBe(260);await settled();
 await page.setViewportSize({width:390,height:844});await page.goto(base);await settled();await popup('dark-mobile');
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
 await page.request.post(base+'/api/auth/logout',{headers:{Origin:base}});await page.goto(base+'/login');await expect(page.locator('html')).toHaveAttribute('data-theme','dark');
 await page.screenshot({path:'.artifacts/redesign-dark-login.png',fullPage:true});
 assert.deepEqual(errors,[]);
 console.log('Redesign OK: temas, persistencia, menus, largura do popup, teclado, camera intermediaria/final, movimento reduzido, mobile e console.');
}finally{if(errors.length)console.log('Browser errors:',errors);await browser.close();}
