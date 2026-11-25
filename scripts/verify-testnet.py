#!/usr/bin/env python3
"""Verify deployed testnet source code; API credentials are never logged."""
import json, os, shutil, subprocess, time
from dotenv import dotenv_values
from eth_abi import encode
from testnet import Testnet, ROOT, LOCAL, RULES, RULES_TYPE, save


def main():
    t = Testnet(roles=())
    m = t.manifest()
    etherscan_key = dotenv_values(ROOT / '.env').get('ETHERSCAN_API_KEY') or os.environ.get('ETHERSCAN_API_KEY')
    if not etherscan_key:
        raise RuntimeError('ETHERSCAN_API_KEY is required for source verification')
    LOCAL.mkdir(parents=True, exist_ok=True)
    if m.get('status')!='confirmed': raise RuntimeError('Confirm deployment first')
    cfg=tuple(m[k] for k in ('usdt','usdc','usdtFeed','usdcFeed'))+(m['maxPriceAge'],)+tuple(m[k] for k in ('tbill','dex','agent'))
    cfgtype='(address,address,address,address,uint256,address,address,address)'
    entries=[
        ('usdt','src/mocks/MockToken.sol:MockToken',['string','string'],['LeashPay Mock USDT','mUSDT']),
        ('usdc','src/mocks/MockToken.sol:MockToken',['string','string'],['LeashPay Mock USDC','mUSDC']),
        ('usdtFeed','src/AtlasRelayFeed.sol:AtlasRelayFeed',['address','uint8'],[m['reporter'],18]),
        ('usdcFeed','src/AtlasRelayFeed.sol:AtlasRelayFeed',['address','uint8'],[m['reporter'],18]),
        ('tbill','src/mocks/MockTBill.sol:MockTBill',['address'],[m['usdt']]),
        ('dex','src/mocks/MockDEX.sol:MockDEX',['address','address'],[m['usdt'],m['usdc']]),
        ('factory','src/LeashVaultFactory.sol:LeashVaultFactory',[cfgtype],[cfg]),
    ]
    smoke=ROOT/'contracts/deployments/97-smoke.json'
    if smoke.exists():
        d=json.loads(smoke.read_text());m['vault']=d['vault']
        entries.append(('vault','src/LeashVault.sol:LeashVault',['address',cfgtype,RULES_TYPE],[d['owner'],cfg,RULES]))
    forge=shutil.which('forge') or str(LOCAL/'foundry-bin/forge')
    env=os.environ.copy();env['ETHERSCAN_API_KEY']=etherscan_key
    result={}
    for name,contract,types,args in entries:
        command=[forge,'verify-contract',m[name],contract,'--chain','97','--watch','--constructor-args','0x'+encode(types,args).hex()]
        try:
            r=subprocess.run(command,cwd=ROOT/'contracts',env=env,capture_output=True,text=True,timeout=90)
            output=(r.stdout+r.stderr).replace(etherscan_key, '[redacted]')
            for value in t.env.values():
                if value and len(value)>16 and not value.startswith('#'):output=output.replace(value,'[redacted]')
            (LOCAL/('verify-'+name+'.log')).write_text(output)
            success=r.returncode==0 and ('successfully verified' in output.lower() or 'already verified' in output.lower())
            result[name]={'address':m[name],'verified':success,'exit_code':r.returncode}
            print(name+': '+('verified' if success else 'not verified; see redacted local log'),flush=True)
        except subprocess.TimeoutExpired:
            result[name]={'address':m[name],'verified':False,'status':'verification response timed out'}
            print(name+': verification response timed out',flush=True)
        save(ROOT/'contracts/deployments/97-verification.json',result)
        time.sleep(1)
    if not all(item['verified'] for item in result.values()):
        raise RuntimeError('Some sources remain unverified; see public verification results and redacted local logs')

if __name__=='__main__':
    try:main()
    except RuntimeError as e:raise SystemExit(str(e)) from None
