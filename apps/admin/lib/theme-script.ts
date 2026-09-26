// The theme's storage key and the <head> script that applies it before the first paint. A plain module (not
// 'use client') so the server-rendered root layout gets the string itself.

export const THEME_KEY = 'theme';

export const THEME_BOOTSTRAP = `try{var t=localStorage.getItem('${THEME_KEY}');var d=document.documentElement;if(t==='light'){d.classList.remove('dark');d.style.colorScheme='light'}else{d.classList.add('dark');d.style.colorScheme='dark'}}catch(e){}`;
