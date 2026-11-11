"""Run after: python3 -m http.server 5173 --directory public.
Uses synthetic fixtures only, never network/exchange orders.
Requires Python playwright + installed Chromium.
"""
import json
import time
from urllib.parse import urlparse, parse_qs
from playwright.sync_api import sync_playwright

NOW = int(time.time() * 1000)

def fixture(route):
    url = urlparse(route.request.url)
    asset = parse_qs(url.query).get('instId', ['BTC-USDT-SWAP'])[0]
    if url.path == '/api/market/instruments':
        body = {'code':'0','data':[
            {'instId':'BTC-USDT-SWAP','instType':'SWAP','state':'live','ctType':'linear','baseCcy':'BTC','settleCcy':'USDT','ctVal':'0.01','ctValCcy':'BTC','minSz':'0.01','lotSz':'0.01','tickSz':'0.1','maxLever':'50'},
            {'instId':'ETH-USDT-SWAP','instType':'SWAP','state':'live','ctType':'linear','baseCcy':'ETH','settleCcy':'USDT','ctVal':'0.1','ctValCcy':'ETH','minSz':'0.1','lotSz':'0.1','tickSz':'0.01','maxLever':'50'},
        ]}
    elif url.path == '/api/status':
        body = {'accountReadAvailable':False,'accountMode':'disabled','tradingAvailable':False,
                'tradingMode':'disabled','autoTradingAvailable':False,'marketProxy':True}
    elif url.path.endswith('/ticker'):
        body = {'code':'0','data':[{'instId':asset,'last':'100','open24h':'99','high24h':'105','low24h':'95','vol24h':'4567','ts':str(NOW)}]}
    elif url.path.endswith('/candles'):
        body = {'code':'0','data':[[str(NOW-i*3600000),'100','102','98',str(100 + (i % 8)/10),'2'] for i in range(100)]}
    elif url.path.endswith('/books'):
        body = {'code':'0','data':[{'asks':[[str(100.1+i/10),str(i+1)] for i in range(8)],'bids':[[str(100-i/10),str(i+2)] for i in range(8)],'ts':str(NOW)}]}
    elif url.path.endswith('/trades'):
        body = {'code':'0','data':[{'instId':asset,'px':'100','sz':'1','side':'buy' if i%2 else 'sell','ts':str(NOW-i*1000)} for i in range(20)]}
    elif url.path.endswith('/funding-rate'):
        body = {'code':'0','data':[{'instId':asset,'instType':'SWAP','fundingRate':'0.0001','settFundingRate':'0.00008','fundingTime':str(NOW+3600000),'nextFundingTime':str(NOW+28800000),'settState':'settled','ts':str(NOW)}]}
    elif url.path.endswith('/open-interest'):
        body = {'code':'0','data':[{'instType':'SWAP','instId':asset,'oi':'12345','oiCcy':'123.45','oiUsd':'1234567.89','ts':str(NOW)}]}
    else:
        raise AssertionError('Unexpected API — real order routes forbidden: ' + url.path)
    route.fulfill(status=200,content_type='application/json',body=json.dumps(body))

def private_fixture(route):
    url = urlparse(route.request.url)
    if url.path == '/api/status':
        body = {'accountReadAvailable':True,'accountMode':'demo','tradingAvailable': True,
                'tradingMode': 'demo', 'autoTradingAvailable': True,
                'maxNotionalUsdt': 25, 'marketProxy': True}
        route.fulfill(status=200,content_type='application/json',body=json.dumps(body))
    elif url.path == '/api/private/account':
        body = {'account': {'mode':'demo','positionMode':'net_mode','availableUsdt':1000,
                            'totalEquityUsdt':1000,'openPositions':[]}}
        route.fulfill(status=200,content_type='application/json',body=json.dumps(body))
    elif url.path == '/api/auto/status':
        body = {'running':False,'mode':'demo','lastMessage':'Bot belum dimulai'}
        route.fulfill(status=200,content_type='application/json',body=json.dumps(body))
    else:
        fixture(route)

def fundamentals_unavailable_fixture(route):
    url = urlparse(route.request.url)
    if url.path.endswith('/funding-rate') or url.path.endswith('/open-interest'):
        route.fulfill(status=502,content_type='application/json',body=json.dumps({'error':'fixture unavailable'}))
    else:
        fixture(route)

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, executable_path='/usr/bin/chromium', args=['--no-sandbox'])
    for width, height in [(1440,1000),(1024,900),(768,1024),(390,844),(320,740)]:
        context = browser.new_context(viewport={'width':width,'height':height},service_workers='block')
        page = context.new_page()
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.route('**/api/**', fixture)
        page.route('https://assets.coincap.io/**', lambda route: route.abort())
        page.goto('http://127.0.0.1:5173/', wait_until='networkidle')
        page.locator('#priceValue').filter(has_text='100').wait_for()
        assert page.locator('.book-row').count()==16
        assert page.locator('.tape-row').count()==10
        assert page.locator('#live').is_hidden(), 'Public UI hides the whole private-account panel when no private backend is available'
        assert page.locator('#liveForm').is_hidden()
        assert page.locator('#pairType').inner_text()=='SWAP'
        assert page.locator('#assetSelect option').count()==2
        assert page.locator('#instrumentCount').inner_text()=='2 PAIR AKTIF'
        assert page.locator('#liveModeBadge').text_content().strip()=='NONAKTIF'
        assert page.locator('#paperTradeBtn').is_disabled()
        assert page.locator('#signalText').inner_text()=='WAIT', 'Neutral signal must be displayed as WAIT, not internal HOLD'
        assert page.locator('#scoreState').inner_text()=='WAIT · sinyal netral'
        assert page.locator('#riskDirection').inner_text()=='WAIT · belum ada arah sinyal'
        assert page.locator('#riskSL').inner_text()=='—' and page.locator('#riskTP').inner_text()=='—'
        assert page.locator('#longScenario').is_visible() and page.locator('#shortScenario').is_visible()
        assert 'Entry 100' in page.locator('#longScenario').inner_text()
        assert 'Entry 100' in page.locator('#shortScenario').inner_text()
        assert 'bukan spot' in page.locator('#paper').inner_text()
        if width == 1440:
            last_price=page.locator('#priceValue').inner_text()
            fail_next_ticker=[True]
            def fail_one_ticker(route):
                if fail_next_ticker[0]:
                    fail_next_ticker[0]=False
                    route.fulfill(status=503,content_type='application/json',body=json.dumps({'error':'fixture outage'}))
                else:
                    fixture(route)
            page.route('**/api/market/ticker**',fail_one_ticker)
            page.locator('#refreshBtn').click()
            page.locator('#marketError').wait_for(state='visible')
            assert page.locator('#priceValue').inner_text()==last_price, 'A failed refresh preserves the last valid price as a stale snapshot'
            assert page.locator('#priceChart canvas').count()>=1, 'A failed refresh keeps the last chart visible'
            assert page.locator('#chartEmpty').is_hidden()
            assert page.locator('#paperTradeBtn').is_disabled(), 'Paper entries are locked until fresh data returns'
            assert page.locator('#marketStrip').get_attribute('aria-busy')=='false'
            page.unroute('**/api/market/ticker**')
        overflow=page.evaluate('''() => ({scroll:document.documentElement.scrollWidth, inner:window.innerWidth, parents:(()=>{let e=document.querySelector("#watchToggle"),r=[];while(e){let b=e.getBoundingClientRect();r.push({tag:e.tagName,id:e.id,className:typeof e.className==="string"?e.className:"",left:b.left,right:b.right,width:b.width,scroll:e.scrollWidth,client:e.clientWidth});e=e.parentElement}return r})(),elements:[...document.querySelectorAll("body *")].map(el=>({tag:el.tagName,id:el.id,className:typeof el.className==="string"?el.className:"",left:el.getBoundingClientRect().left,right:el.getBoundingClientRect().right,width:el.getBoundingClientRect().width})).filter(x=>x.right>window.innerWidth+1||x.left< -1).slice(0,12)})''')
        assert overflow['scroll'] <= overflow['inner'], f'Viewport overflow at {width}: {overflow}'
        chart = page.locator('#priceChart').bounding_box()
        chart_wrap = page.locator('.chart-wrap').bounding_box()
        assert chart['width'] > 200 and chart_wrap['height'] >= 300, (width, chart, chart_wrap)
        assert page.locator('#priceChart canvas').count() >= 1, 'TradingView Lightweight Charts renders locally bundled canvases'
        assert not page.locator('#taConfirmInput').is_checked(), 'EMA/MACD-volume confirmation stays opt-in by default'
        assert page.locator('#taConfirmInput').get_attribute('aria-describedby') == 'taConfirmHelp'
        assert page.locator('#fundingRate').inner_text() == '+0.010000%'
        assert page.locator('#openInterestValue').inner_text() == '1,234,567.89 USD'
        assert 'konteks derivatif' in page.locator('#fundamentals').inner_text().lower()
        assert 'bukan valuasi fundamental token' in page.locator('#fundamentals').inner_text().lower()
        page.locator('#instrumentSearch').fill(' eTh-usdt ')
        assert page.locator('#instrumentResults').is_visible()
        result_box=page.locator('#instrumentResults').bounding_box()
        assert result_box['x']+result_box['width'] <= width+1, f'Search popup extends beyond viewport at {width}: {result_box}'
        assert page.locator('#instrumentResults [role="option"]').count()==1, 'Search results must contain only matching instruments'
        assert page.locator('#assetSelect option').count()==2, 'The active-pair selector remains a complete accessible fallback'
        assert page.locator('#assetSelect').input_value()=='BTC-USDT-SWAP', 'Typing a query must not silently change the active market'
        page.locator('#instrumentResults [role="option"]').click()
        page.locator('#chartAsset').filter(has_text='ETH-USDT-SWAP').wait_for()
        assert page.locator('#instrumentSearch').input_value()==''
        assert page.locator('#assetSelect').input_value()=='ETH-USDT-SWAP'
        page.locator('#instrumentSearch').fill('not-a-real-coin')
        assert page.locator('#instrumentResults').is_visible(), 'No-match state remains visible rather than silently restoring the selected pair'
        assert page.locator('#instrumentResults [role="option"]').count()==0
        assert 'Tidak ada pair cocok' in page.locator('#instrumentResults').inner_text()
        assert page.locator('#instrumentSearchStatus').inner_text()=='Tidak ada instrumen yang cocok.'
        page.locator('#instrumentSearch').fill('btc/usdt')
        assert page.locator('#instrumentResults [role="option"]').count()==1, 'Slash-separated compact queries match the base/quote pair'
        page.locator('#instrumentSearch').press('ArrowDown')
        page.locator('#instrumentSearch').press('Enter')
        page.locator('#chartAsset').filter(has_text='BTC-USDT-SWAP').wait_for()
        assert page.locator('#instrumentSearch').input_value()==''
        assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth'), f'Search results overflow at {width}'
        page.get_by_role('button',name='4H',exact=True).click()
        assert page.get_by_role('button',name='4H',exact=True).get_attribute('aria-pressed')=='true'
        page.locator('#installBtn').click()
        assert page.locator('#installHelp').is_visible()
        page.locator('#closeInstallHelp').click()
        assert not errors, errors
        print(f'ui-smoke: {width}x{height} OK — no overflow, chart, live Swap fixtures, dynamic catalog, safe paper state and install help')
        context.close()
    context = browser.new_context(viewport={'width':390,'height':844},service_workers='block')
    page = context.new_page()
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.route('**/api/**', private_fixture)
    page.route('https://assets.coincap.io/**', lambda route: route.abort())
    page.goto('http://127.0.0.1:5173/', wait_until='networkidle')
    page.locator('#autoTraderBox').wait_for(state='visible')
    assert page.locator('#autoStartBtn').is_disabled(), 'Auto start stays disabled before credentials/account confirmation'
    page.locator('#liveToken').fill('mock-admin-token-not-secret')
    page.locator('#accountConnectBtn').click()
    page.locator('#accountSummary').wait_for(state='visible')
    page.locator('#autoInstrumentSearch').fill('eth-usdt')
    assert page.locator('#autoInstrumentResults [role="option"]').count()==1
    page.locator('#autoInstrumentResults [role="option"]').click()
    assert page.locator('#autoInstrument').input_value()=='ETH-USDT-SWAP', 'Auto-trade pair search updates only its pair selector'
    assert page.locator('#autoInstrumentSearch').input_value()==''
    page.locator('#autoConfirmInput').fill('MULAI AUTO TRADE DEMO')
    assert page.locator('#autoStartBtn').is_enabled(), 'Only the matching demo confirmation enables start after account connection'
    assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth'), 'Private controls overflow on mobile'
    assert not errors, errors
    print('ui-smoke: configured demo account panel OK — private account data mocked; bot was not started and no order was submitted')
    context.close()

    def read_only_fixture(route):
        url = urlparse(route.request.url)
        if url.path == '/api/status':
            body = {'accountReadAvailable':True,'accountMode':'demo','tradingAvailable':False,
                    'tradingMode':'disabled','autoTradingAvailable':False,'marketProxy':True}
        elif url.path == '/api/private/account':
            body = {'account': {'mode':'demo','positionMode':'net_mode','availableUsdt':1000,
                                'totalEquityUsdt':1000,'openPositions':[]}}
        else:
            fixture(route)
            return
        route.fulfill(status=200,content_type='application/json',body=json.dumps(body))

    context = browser.new_context(viewport={'width':390,'height':844},service_workers='block')
    page = context.new_page()
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.route('**/api/**', read_only_fixture)
    page.route('https://assets.coincap.io/**', lambda route: route.abort())
    page.goto('http://127.0.0.1:5173/', wait_until='networkidle')
    page.locator('#liveForm').wait_for(state='visible')
    assert 'READ-ONLY' in page.locator('#safetyTitle').inner_text()
    assert page.locator('#executionLockNote').is_visible()
    assert page.locator('#manualLiveDetails').is_hidden(), 'Manual execution controls stay hidden in read-only mode'
    assert page.locator('#autoTraderBox').is_visible()
    page.locator('#liveToken').fill('mock-admin-token-not-secret')
    page.locator('#accountConnectBtn').click()
    page.locator('#accountSummary').wait_for(state='visible')
    page.locator('#autoConfirmInput').fill('MULAI AUTO TRADE DEMO')
    assert page.locator('#autoStartBtn').is_disabled(), 'Typed confirmation cannot bypass disabled auto-execution flags'
    assert page.locator('#manualLiveDetails').is_hidden()
    assert not errors, errors
    print('ui-smoke: read-only demo account panel OK — account read available, order and auto execution locked')
    context.close()

    context = browser.new_context(viewport={'width':390,'height':844},service_workers='block')
    page = context.new_page()
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.route('**/api/**', fundamentals_unavailable_fixture)
    page.route('https://assets.coincap.io/**', lambda route: route.abort())
    page.goto('http://127.0.0.1:5173/', wait_until='networkidle')
    page.locator('#priceValue').filter(has_text='100').wait_for()
    assert page.locator('#fundingRate').inner_text() == '—'
    assert page.locator('#openInterestValue').inner_text() == '—'
    assert page.locator('#rsiValue').inner_text() != '—', 'Missing fundamental context must not suppress technical analysis'
    assert 'konteks derivatif' in page.locator('#fundamentals').inner_text().lower()
    assert 'belum tersedia' in page.locator('#fundamentals').inner_text().lower()
    assert not errors, errors
    print('ui-smoke: unavailable funding/open interest stay explicitly unavailable while technical chart/indicators continue from fixtures')
    context.close()
    browser.close()
