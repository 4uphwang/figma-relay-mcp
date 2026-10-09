# Figma 실행 가능성 실험 결과

- 날짜: 2026-10-10
- 환경: Figma 데스크톱 앱, 무료(Starter) 계정, 개발 플러그인(`spike/manifest.json`)

## 결과 원문

플러그인 창:
```
{
 "newFunction": "제목 없음",
 "eval": 2,
 "pdfBytes": 5376,
 "pdfHead": "%PDF-"
}
error ws://127.0.0.1:38451
open ws://localhost:38451
```

서버 로그(`spike/server.mjs`, 127.0.0.1:38451):
```
text {"url":"ws://localhost:38451","newFunction":"제목 없음","eval":2,"pdfBytes":5376,"pdfHead":"%PDF-"}
binary 3 bytes
```

참고: 처음에는 manifest `devAllowedDomains`에 `ws://127.0.0.1:38451`을 넣었더니 Figma가 불러오기를 거절했다 — "Manifest error: Invalid value for devAllowedDomains. 'ws://127.0.0.1:38451' must be a valid URL." `localhost`만 남기자 불러와졌다.

## 결론

- execute 방식: new Function (eval도 가능)
- WebSocket 주소: ws://localhost:38451 (manifest는 127.0.0.1을 거절, 서버는 127.0.0.1에 바인딩한 채로 연결됨)
- PDF 내보내기: 가능 (`exportAsync({format:'PDF'})`, 무료 계정)
