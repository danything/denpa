import { describe, expect, test } from 'bun:test';
import { parseXmlAit } from './xml-ait';

/** ETSI TS 102 809 の形。値は作りもの */
const AIT = `<?xml version="1.0" encoding="UTF-8"?>
<mhp:ServiceDiscovery xmlns:mhp="urn:dvb:mhp:2009" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <mhp:ApplicationDiscovery DomainName="example.jp">
    <mhp:ApplicationList>
      <mhp:Application>
        <mhp:appName Language="jpn">番組 &amp; 連動</mhp:appName>
        <mhp:applicationIdentifier>
          <mhp:orgId>16</mhp:orgId>
          <mhp:appId>3</mhp:appId>
        </mhp:applicationIdentifier>
        <mhp:applicationDescriptor>
          <mhp:type><mhp:OtherApp>text/html</mhp:OtherApp></mhp:type>
          <mhp:controlCode>AUTOSTART</mhp:controlCode>
        </mhp:applicationDescriptor>
        <mhp:applicationTransport xsi:type="mhp:HTTPTransportType">
          <mhp:URLBase>https://hc.example.jp/app/</mhp:URLBase>
        </mhp:applicationTransport>
        <mhp:applicationLocation>index.html?a=1&amp;b=2</mhp:applicationLocation>
      </mhp:Application>
      <mhp:Application>
        <mhp:appName Language="jpn">止める</mhp:appName>
        <mhp:applicationIdentifier><mhp:orgId>16</mhp:orgId><mhp:appId>4</mhp:appId></mhp:applicationIdentifier>
        <mhp:applicationDescriptor><mhp:controlCode>KILL</mhp:controlCode></mhp:applicationDescriptor>
        <mhp:applicationTransport><mhp:URLBase>https://hc.example.jp/kill/</mhp:URLBase></mhp:applicationTransport>
        <mhp:applicationLocation>index.html</mhp:applicationLocation>
      </mhp:Application>
    </mhp:ApplicationList>
  </mhp:ApplicationDiscovery>
</mhp:ServiceDiscovery>`;

describe('parseXmlAit', () => {
    test('開けるアプリの名前・識別・行き先を拾う。KILL は出さない', () => {
        expect(parseXmlAit(AIT)).toEqual([
            {
                name: '番組 & 連動',
                url: 'https://hc.example.jp/app/index.html?a=1&b=2',
                organisationId: 16,
                applicationId: 3,
                autostart: true,
            },
        ]);
    });

    test('接頭辞が無くても読む。controlCode が無ければ PRESENT', () => {
        const plain = `<ServiceDiscovery><ApplicationList><Application>
            <applicationIdentifier><orgId>0x10</orgId><appId>1</appId></applicationIdentifier>
            <applicationTransport><URLBase>http://a.example/</URLBase></applicationTransport>
            <applicationLocation>top.html</applicationLocation>
        </Application></ApplicationList></ServiceDiscovery>`;
        expect(parseXmlAit(plain)).toEqual([
            {
                name: '',
                url: 'http://a.example/top.html',
                organisationId: 16,
                applicationId: 1,
                autostart: false,
            },
        ]);
    });

    test('URL の頭が http(s) でないもの・壊れたものは出さない', () => {
        expect(parseXmlAit(AIT.replace('https://hc.example.jp/app/', 'javascript:alert(1)//'))).toEqual([]);
        expect(parseXmlAit('<html>not an ait</html>')).toEqual([]);
    });
});
