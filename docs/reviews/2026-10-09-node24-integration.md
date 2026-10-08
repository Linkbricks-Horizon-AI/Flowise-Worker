# Node 24 및 Flowise–Worker 통합 기록 — 2026-10-09

원본 `9291856d1ea4a4ceea9f8fef8ce14f4f6c81e8eb`를 병합 이력으로 보존하면서
본 수정본의 동작을 유지한다. Node 24.21.0 / pnpm 10.26.0 / Flowise 3.1.4를
기준으로 Web과 Worker가 같은 공통 소스와 lockfile을 사용한다.

## 보존 및 변경 결정

- Vora 모델·하위 flow 도구·override, 커스텀 임베드의 기존 Git 커밋을 보존했다.
- direct tool return, progress, relay 채널, 개별 중단, 큐 완료 복구를 유지했다.
- SQL의 CTE 쓰기 차단, SSO identity binding, lazy import를 유지했다.
- 원본 Cloud 서비스 종료용 가입·초대 제한과 종료 배너는 반영하지 않았다.
- 공개 임베드 중단 계약과 큐 관리자 Basic Auth를 보존하고 관리자 rate limit을 추가했다.
- AWS SDK/S3 타입, TypeORM, MCP, multer 등은 의존 소스와 lockfile을 함께 반영했다.
- protobufjs 7.x, Elasticsearch transport 8.x 범위를 유지했다. xlsx 0.20.3 및
  기존 Groq override도 보존했다.
- `@tootallnate/once`는 보안 수정이 있는 CommonJS 2.0.1로 고정했다. 원본의
  3.x 일괄 override는 실제 서버 테스트 4개 suite에서 ESM 로드 실패를 유발했다.
- Canvas 3.2.0 및 Debian 기반 이미지를 사용한다. Alpine에서 확인된 ONNX
  native load abort와 설치 스크립트 미실행 Canvas 문제를 함께 해결한다.
- Sharp 0.32.6/0.33.5 동시 로드 시 재현한 native abort를 해결하기 위해 0.33.5로
  통일하고 Transformers의 이미지 변환 API도 함께 검증한다.
- 간접 설치되던 Node 18 타입 대신 components에 `@types/node ^24.19.1`을 명시하고
  표준 라이브러리 선언을 ES2022로 맞췄다. JavaScript 출력 target은 유지했다.
- 각 Docker 빌드에 네이티브 실행 검사를 포함해 설치 성공과 실제 로드를 구별한다.
- `docker/Dockerfile`도 npm 원본 배포본 대신 현재 수정본 소스를 빌드한다.
- Worker의 완료 로그는 공통 BaseQueue에 보존했다. 두 저장소는 root Dockerfile의
  시작 명령(Web/Worker)을 제외한 공통 코드를 일치시킨다.
- lint에서 발견한 기존 포맷 오류와 임베드 래퍼의 누락된 propTypes를 수정했다.
  관련 Vora 코드 수정은 포맷에 한정된다.

## 검증 결과

Node 24.21.0 / pnpm 10.26.0 / Linux amd64 기준 결과다.

| 검증 | 결과 |
| --- | --- |
| 전체 Jest | **190 suites / 3,864 tests 통과**, 실패 0 |
| components | 35 suites / 1,138 tests 통과 |
| server | 54 suites / 1,061 tests 통과 |
| agentflow | 73 suites / 1,255 tests 통과 |
| observe | 25 suites / 335 tests 통과 |
| UI | 3 suites / 75 tests 통과 |
| 별도 Worker 환경의 server + components | **89 suites / 2,199 tests 통과** |
| 전체 빌드 | SDK 포함 6개 package 성공 |
| lint | 오류 0, 기존 경고 8개. 마지막 manifest/tsconfig 수정도 개별 검사 통과 |
| Web / Worker 공통 파일 | **2,477개 일치**, root Docker CMD만 허용된 차이 |
| 배포 이미지의 고정 설치 및 빌드 | 양쪽 모두 새 pnpm store에서 frozen install, 배포용 4개 package 빌드와 native 검사 통과 |
| native 실행 | SQLite 쿼리, FAISS 검색, Canvas PNG, 공통 Sharp 디코딩, ONNX Tensor, Transformers resize, 이벤트 promise 통과 |
| 실제 Web–Worker 연동 | PostgreSQL/Redis 연결, 로그인, 큐 작업 반환, BullMQ completed 전환 로그 확인 |
| 관리자 화면 | 미인증 401, 정상 Basic Auth 200, 연속 101개 요청 중 100개 200 / 1개 429 |
| 시스템 Chromium | Puppeteer로 7,087바이트 PDF 생성 성공 |

실행한 주요 명령:

```bash
pnpm install --frozen-lockfile
pnpm lint
pnpm exec turbo run build --concurrency=1
pnpm exec turbo run test --concurrency=1 -- --runInBand
pnpm exec turbo run test --filter=flowise --filter=flowise-components --concurrency=1 -- --runInBand
node scripts/check-runtime-dependencies.cjs
node scripts/check-worker-sync.mjs /path/to/Flowise /path/to/Flowise-Worker
docker build --platform linux/amd64 -t flowise-review .
```

초기 Alpine 이미지의 캐시 없는 빌드만으로는 발견되지 않았던 native 실패를
직접 로드 검사에서 찾아 Debian/Canvas/Sharp 설정을 보정했다. 최종 Debian
이미지의 pnpm 설치 역시 기존 store 없이 수행했다.

커스텀 핵심 경로 18개 중 17개는 기준선과 byte 단위로 일치한다. VoraRouter2는
Prettier 포맷만 변경됐고 정규화 비교로 확인했다. 마지막 타입 수정 전후의 실제
서버·컴포넌트 JavaScript 출력 1,172개도 동일하다. 연동 검증한 이미지와 최종 타입
설정의 실행 코드가 일치함을 아래 aggregate SHA-256으로 확인했다.

- components JS 543개: `f1ffb543df993a06a33a31439f3d7a1dd6d653a39cc563666b58b3e8e981dd56`
- server JS 629개: `f1c84d47be242487bdcdb6ede0948ae8869e1c8983b548dc2bc9e593853705d3`

테스트 로그, 이미지 빌드 로그 및 로컬 원본 설정 백업은 작업 시점의
`/private/tmp/flowise-upgrade-20261009-frrgs_4j/`에 저장했다. 이 경로는 임시
검증 산출물이며 저장소에 비밀값이나 운영 DB 자료를 추가하지 않았다.

## 이후 업데이트의 완료 조건

1. 양쪽 저장소의 최신 main과 깨끗한 통합 브랜치에서 시작한다.
2. 원본 변경을 Flowise에 병합한다. `.upstream-sync.json`의 예외 목록을 검토하며
   충돌 없는 변경도 확인한다. 원본 종료 정책을 제품 정책으로 자동 채택하지 않는다.
3. Node/pnpm/manifest/lockfile을 함께 맞추고 Docker 고정 설치·전체 빌드·전체 테스트·lint를 실행한다.
4. 검증한 Flowise 커밋을 Worker에 merge한다. 공통 코드 충돌은 검증된 Flowise를
   기준으로 해결하고 Worker의 root `CMD ["pnpm", "run", "start-worker"]`를 유지한다.
5. 아래 명령이 성공해야 두 저장소 업데이트가 완료된 것으로 본다.
   ```bash
   node scripts/check-worker-sync.mjs /path/to/Flowise /path/to/Flowise-Worker
   ```
6. Worker 이미지 빌드와 실제 Web→Redis→Worker→Web 작업을 확인한 뒤 각각 commit/push한다.
   강제 push를 하지 않고 원본 및 양쪽 저장소의 병합 이력을 유지한다.
7. 운영자가 Render에서 Worker → Web 순서로 수동 배포한다. Web `/api/v1/ping`,
   Worker Redis 연결·작업 완료 로그와 실제 Vora 요청·스트리밍·중단을 확인한다.

동기화 검사 스크립트는 공통 파일 누락과 의존성 차이를 실패로 처리한다.
GitHub 간 자동 push나 Render 자동 배포는 새로 설정하지 않았다.

## 배포 범위 및 한계

검증에는 격리한 로컬 PostgreSQL 16/Redis 7과 Linux amd64 컨테이너를 사용한다.
운영 DB·외부 LLM/API 자격증명은 사용하지 않는다. Node 호환성·빌드·회귀 테스트·큐
왕복은 배포 전 검증이며 실제 Render 리소스 제한, Dashboard 설정, 외부 모델 결과는
운영자의 수동 배포 및 로그로 최종 확인한다. 기존 legacy 패키지의 peer/deprecation
경고는 완전히 제거하지 않았으며, 경고 억제로 설치를 통과시키지 않았다.
