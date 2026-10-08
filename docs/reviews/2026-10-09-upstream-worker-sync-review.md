# Flowise 원본 업데이트 및 Worker 동기화 검토 — 2026-10-09

> 이 문서는 구현 전 검토 기록이다. 이후 반영 결과는 [통합 검증 기록](2026-10-09-node24-integration.md)을 참조한다.

검토 결론: Node 24 전환과 원본의 미반영 수정은 필요하다. 다만 원본의 운영 정책 변경과 현재 수정본의 기능 보강이 섞여 있으므로, 기존 기능을 보존하는 통합 브랜치에서 반영한 뒤 Flowise-Worker까지 같은 변경 단위로 검증해야 한다. 이번 작업은 검토이며, 이 문서 외에 프로젝트 소스·설정·의존성·브랜치·배포는 변경하지 않았다.

**비교 기준**

| 대상 | 확인한 기준 | 상태 |
| --- | --- | --- |
| FlowiseAI/Flowise 원본 main | `9291856d1ea4a4ceea9f8fef8ce14f4f6c81e8eb` | 2026-08-13 마지막 커밋, 같은 날 저장소 보관 처리 |
| 원본 최신 정식 릴리스 | `flowise@3.1.4`, `a65f81bb43ef66d3ce734bf0dff4223ae8041c95` | 2026-07-29 발행 |
| 본 프로젝트 | `9721ccce88913d50feea5d5e2695655d43f28544` | 로컬 main과 Linkbricks-Horizon-AI/Flowise 원격 main 일치 |
| Flowise-Worker | `8535d90bdbab734b1373fb82b5d763d5882bbe4e` | 로컬 main과 Linkbricks-Horizon-AI/Flowise-Worker 원격 main 일치 |

원본은 현재 읽기 전용이다. 원본의 향후 업데이트를 기다리는 것만으로 런타임·의존성 유지보수가 이루어지지는 않는다. 원본 변경 감지와 수정본 자체 유지보수, 수정본에서 Worker로의 전파를 각각 관리해야 한다. [원본 저장소](https://github.com/FlowiseAI/Flowise), [공식 종료 안내](https://github.com/FlowiseAI/Flowise/discussions/6727)

본 프로젝트와 원본의 공통 조상은 `b2550f7f`다. Git 이력상 원본 쪽에만 있는 커밋은 39개지만, `git cherry` 기준 21개는 동일 패치가 이미 반영되어 있다. 나머지 18개도 전부 미반영이라는 뜻은 아니다. 예를 들어 SSO identity binding의 엔티티와 네 종류 DB migration 디렉터리는 현재 원본과 동일하다. 커밋 번호와 패치 동등성, 최종 소스 상태를 함께 확인해야 한다.

**1. [높음] Node와 pnpm을 모든 실행 경로에서 함께 맞춰야 한다.**

| 설정 | 현재 Flowise / Worker | 원본 main |
| --- | --- | --- |
| 루트 및 server `engines.node` | `^20` | `^24` |
| `.nvmrc` | `v20.20.2` | `v24.15.0` |
| Node CI | `20.20.2` | `24.15.0` |
| 루트 Dockerfile | `node:20-alpine`, pnpm `10.25.0` | `node:24-alpine`, pnpm `10.26.0` |
| docker/worker/Dockerfile | `node:20-alpine`, pnpm 버전 미고정 | `node:24-alpine`, pnpm `10.26.0` |
| pnpm engines | `>=10.21.0` | `^10.26.0` |

Node 20은 공식 지원이 종료되었고 Node 24는 LTS다. 전환 기준은 Node 24 LTS로 잡되, 실제 패치 버전은 구현 시점의 지원 버전을 정해 검증하고 고정한다. Node 버전만 바꾸고 기존 pnpm·lockfile·네이티브 모듈 상태를 그대로 사용하는 방식으로는 호환성을 확인할 수 없다. [Node 공식 릴리스 상태](https://nodejs.org/en/about/previous-releases)

수정 범위에는 `.nvmrc`, 루트 및 server package.json, 세 Dockerfile, Node CI, 패키지 발행 workflow, Docker 이미지 workflow의 기본값, AGENTS.md의 Node 20 안내가 포함된다. `packageManager`도 현재 없으므로 검증한 pnpm 단일 버전을 명시할 필요가 있다. `.npmrc:7`은 `engine-strict=false`여서 잘못된 Node 사용을 차단하지 않는다. 이번 검토 셸도 실제로는 Node `23.5.0`, pnpm `10.26.0`이었다.

근거: [루트 engines](../../package.json#L103), [server engines](../../packages/server/package.json#L60), [Dockerfile](../../Dockerfile#L7), [Worker Dockerfile](../../docker/worker/Dockerfile#L1), [Node CI](../../.github/workflows/main.yml#L17).

**2. [높음] pnpm 업그레이드에는 커스텀 임베드의 설치 정책 정리가 선행되어야 한다.**

현재 루트 package.json의 `pnpm.onlyBuiltDependencies`와 pnpm-workspace.yaml에 허용 목록이 중복되어 있다. Git 임베드의 정확한 tarball URL은 workspace 쪽에만 있다. 기존 장애 문서는 최신 pnpm 설치 과정에서 루트 설정이 workspace 설정을 가리고, 캐시가 없는 빌드에서 `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`가 발생한 사례를 기록하고 있다. 현재 Docker의 10.25.0 고정은 이 문제를 피하기 위해 적용된 것이다. [기존 장애 기록](../deployment-troubleshooting.md#L22)

이번에 확인한 pnpm 10.26.0의 `config get onlyBuiltDependencies`에는 URL이 표시됐다. 그러나 설치 경로는 별도로 루트 manifest 옵션을 다시 합친다. 따라서 설정 조회만으로 새 설치의 성공을 판정할 수 없다. 이번 검토에서는 새 store 설치 실패를 재현하지 않았으므로 현재 모든 환경에서 실패한다고 단정하지 않는다. Git 의존성 prepare 제한 자체는 pnpm 10.26 공식 변경사항이다. [pnpm 공식 릴리스](https://github.com/pnpm/pnpm/releases/tag/v10.26.0)

반영 시에는 빌드 허용 목록을 한 곳으로 통합하고, 선택한 pnpm 버전에서 lockfile의 임베드 해시와 허용 항목을 일치시킨 뒤 새 store에서 설치해야 한다. 전체 빌드 스크립트를 무조건 허용하는 설정으로 우회할 필요는 없다. 현재 임베드 해시 `1404920a3c279b52bdafe97936d35f16ec61e752`는 두 저장소의 lockfile과 workspace 설정에서 일치한다.

근거: [루트 허용 목록](../../package.json#L71), [workspace 허용 목록](../../pnpm-workspace.yaml#L8), [커스텀 임베드 의존성](../../packages/ui/package.json#L44).

**3. [높음] 병합 충돌에는 실제 제품 동작과 기존 보강이 걸려 있다.**

임시 bare 저장소에서 `git merge-tree --write-tree --name-only`로 모의 병합했다. 실제 작업 트리에서 merge하거나 충돌을 해결하지 않았다.

| 병합 방향 | 충돌 파일 수 |
| --- | ---: |
| 원본 main → Flowise | 13 |
| 원본 3.1.4 태그 → Flowise | 14 |
| 원본 main → Worker | 13 |
| 현재 Flowise → 현재 Worker | 4 |

원본 main과의 충돌 파일은 `Dockerfile`, `package.json`, `pnpm-lock.yaml`, components의 `jest.config.js`, `S3Directory.ts`, `S3File.ts`, `validator.ts`, `validator.test.ts`, server의 `organization-user.service.ts`, `SSOBase.ts`, `index.ts`, `routes/chat-messages/index.ts`, `services/nodes/index.ts`다.

다음 사항은 원본 쪽 내용을 일괄 선택하는 해결을 적용하면 안 되는 구체적인 이유다.

- 공개 임베드의 대화 중단: 현재 `/api/v1/chatmessage/abort`는 공개 위젯이 호출하도록 수정되어 있다. 원본은 편집 권한 검사를 추가한다. 공개 위젯 호출의 인증·소유권 계약을 유지하면서 원본의 접근 제어 의도를 반영하는 별도 처리가 필요하다. [현재 라우트](../../packages/server/src/routes/chat-messages/index.ts#L17), [원본 수정](https://github.com/FlowiseAI/Flowise/commit/abe4a8601a058047b350c260676826e21dd14101)
- SQL 검증: 현재 `assertReadOnlySqlStatement`에는 `WITH` 다음에 오는 쓰기·DDL 구문을 막는 추가 검사가 있다. 충돌의 원본 쪽에는 이 블록이 없다. 이 보강과 대응 테스트를 보존해야 한다. [현재 검사](../../packages/components/src/validator.ts#L396)
- 큐 완료 대기: 현재 노드 실행 서비스의 `resilientWaitUntilFinished`는 원본의 `job.waitUntilFinished`보다 추가 복구 동작을 갖고 있다. import 충돌을 해결하면서 이 경로를 잃지 않아야 한다. [현재 노드 서비스](../../packages/server/src/services/nodes/index.ts#L154)
- 큐 관리자 화면: 현재 Basic Auth와 원본의 JWT·RBAC·rate limit 구성이 충돌한다. 운영에서 사용하는 인증 방식을 확인하고 해당 접근 경로를 검증해야 한다. [원본 수정](https://github.com/FlowiseAI/Flowise/commit/1939b5f3747eff2641f3b7332e9fff33d637fbee)

긍정적인 점도 있다. 모의 병합 결과에서 `VoraChatflowTool`, `ChatVoraRouter`, `ChatVoraRouter2`, direct tool return, stream progress, Vora override, server queue 디렉터리, AbortControllerPool, SSEStreamer, relayConfig는 현재 Flowise와 동일하게 남았다. 커스텀 임베드 Git 의존성과 workspace 허용 목록도 정상적인 3-way 병합에서는 보존됐다. 이는 텍스트 보존 확인이며, 새 의존성에서의 동작 보장은 아니다.

**4. [높음] 원본의 서비스 종료 정책은 일반적인 수정과 분리해야 한다.**

원본의 `5ecc3c5c`는 Cloud 신규 가입·초대·SSO 신규 등록을 제한하고 UI에 서비스 종료 안내를 추가한다. 모의 병합에서는 account service와 UI 일부가 충돌 없이 변경되므로, 충돌 파일만 검토하면 이 동작 변경을 놓칠 수 있다. Cloud 모드를 사용하는 경우 기존 가입 기능에 직접 영향을 준다. 현재 실제 배포의 플랫폼 모드는 조회하지 않았다. [원본 커밋](https://github.com/FlowiseAI/Flowise/commit/5ecc3c5cb54c13266b65653b04008ae6f18a3039)

가입 차단·서비스 종료 문구는 수정본의 운영 정책으로 별도 결정해야 한다. 같은 커밋에 들어 있는 취소된 구독 처리 등 다른 수정까지 함께 버리지 않도록 변경 단위를 나누어 검토한다. 기존 SSO의 lazy import와 인증 보강 역시 보존 대상이다.

**5. [높음] 의존성 변경은 package.json뿐 아니라 실제 lockfile 해석 결과를 기준으로 검증해야 한다.**

| 항목 | 현재 lockfile | 원본 main lockfile | 주요 확인 대상 |
| --- | --- | --- | --- |
| AWS Bedrock SDK | 3.966.0 | 3.1014.0 | Bedrock 모델·스트리밍 |
| AWS S3 SDK | 3.844.0 | 3.1065.0 | S3 loader·storage·credential 타입 |
| TypeORM | 0.3.20 | 0.3.30 | DB 접근·기존 migration |
| MCP SDK | 1.0.1 / 1.12.0 / 1.27.1 / 1.29.0 공존 | 1.29.0 | 커스텀 MCP·stdio·HTTP |
| multer | 1.4.5-lts.1 / 2.0.2 공존 | 2.2.0 | 파일 업로드·저장소 adapter |
| Qdrant REST client | 1.17.0 | 1.18.0 | 벡터 저장·검색 |
| prebuild-install | 7.1.2 | 7.1.3 | 새 환경의 네이티브 설치 |
| protobufjs | 7.4.0 | 8.6.2 | 상위 패키지와 타입·런타임 호환 |
| @elastic/transport | 8.4.1 | 9.3.7 | Elasticsearch client 호환 |

원본의 `protobufjs >=7.5.5`, `@elastic/transport >=8.9.3` 같은 상한 없는 override는 실제로 다음 major까지 해석되어 있다. 이 표는 확인된 해석 결과이며 해당 조합의 런타임 실패를 입증한 것은 아니다. 호환 범위를 정하고 테스트하여 lockfile을 재생성해야 한다.

수정본에서 별도로 보존·검증할 사항은 다음과 같다.

- `flowise-embed`는 원본의 npm `latest`와 다른 `saxoji/FlowiseChatEmbed`다. 임베드 커스텀 기능과 prepare 허용 설정을 함께 유지한다.
- `xlsx`는 현재 0.20.3 tarball로 고정되어 있지만 원본은 0.18.5다. 원본 manifest·lockfile을 통째로 교체하면 현재 버전이 내려간다.
- `groq-sdk: 0.5.0`은 과거 TypeScript 빌드 오류를 해결한 수정본의 override다. 원본에서는 제거되어 있으므로, 제거 여부는 Groq 및 관련 LangChain 빌드 검증으로 결정한다.
- `faiss-node 0.5.1`, `sqlite3 5.1.7`, `canvas 2.11.2`, `onnxruntime-node 1.14.0`은 Node 24의 실제 대상 OS·아키텍처에서 설치·로드를 검증한다. 선택적 의존성의 존재가 모든 배포에서 사용된다는 뜻은 아니다.

S3 SDK 업데이트에는 S3 loader의 `AWSCredentials` 타입 및 storage provider 코드 변경도 동반된다. 버전 숫자만 먼저 옮기는 변경은 피하고 해당 소스와 테스트를 묶어서 반영한다. 원본과 현재의 DB migration 파일은 동일하므로 이번 비교에서 새 migration 파일을 추가할 근거는 발견되지 않았다. TypeORM 변경 이후 기존 DB 동작 검증은 여전히 필요하다.

**6. [높음] Worker 동기화는 현재 수작업 상태이며, 공통 코드의 일치 조건을 명시해야 한다.**

두 저장소의 최종 트리는 17개 파일이 다르다. 차이에는 Worker 시작 명령, Worker 완료 로그, 웹의 `relayExecutionId` 생성·중단 API·chatflow 재사용 처리와 관련 테스트가 포함된다. 차이 전체를 Worker의 기능 누락으로 판단할 수는 없다. Worker의 실제 작업 실행 경로인 PredictionQueue·RedisEventPublisher·RedisEventSubscriber·AbortControllerPool은 두 저장소에서 동일하며, 전체 components와 pnpm-lock.yaml도 동일하다. Worker는 전달받은 `relayExecutionId`를 사용해 채널과 중단 키를 분리하도록 이미 구현되어 있다. [PredictionQueue](../../packages/server/src/queue/PredictionQueue.ts#L74)

현재 Flowise → Worker 모의 병합의 충돌은 public/internal prediction controller와 `finalizeSseResponse.test.ts`, `relay-token-path.integration.test.ts`의 4개다. 최초 기준선 통합에서 이를 정리해야 이후 반영을 반복 가능하게 만들 수 있다.

검토한 두 저장소의 workflow에는 상대 저장소 변경 감지·동기화 PR 생성·공통 소스 비교가 없다. 향후에는 다음을 업데이트의 완료 조건으로 삼는 것을 권고한다.

1. Flowise에서 원본 변경과 커스텀 보존 사항을 통합하고 테스트한다.
2. 검증된 Flowise 커밋을 기준으로 Worker 동기화 PR을 생성한다. 최초 기준선 이후에는 병합 이력을 유지하고, 필요한 cherry-pick에는 원본 SHA를 남긴다.
3. 공통 소스·의존성·lockfile의 일치를 검사하고, Worker 전용 시작 명령 등 승인된 차이만 예외 목록으로 관리한다. 현재 웹 전용 소스 차이를 유지할지 공통화할지도 최초 통합에서 정한다.
4. Worker의 테스트와 실제 Web ↔ Worker 계약 검증이 끝난 뒤 양쪽 변경을 하나의 릴리스 묶음으로 기록한다. 커밋 SHA 자체는 서로 달라도 된다.
5. 큐 프로토콜에 변화가 있다면 하위 호환성을 확인하고 Worker → Web 순서로 배포한다. 현재 relay 기능도 이 순서를 명시하고 있다. [배포 순서 근거](../../packages/server/src/utils/relayConfig.ts#L19)

변경 감지와 PR 생성의 자동화는 권고안이며 이번에 설치하거나 활성화하지 않았다. 기존 배포 문서에는 `saxoji/Flowise → Linkbricks Flowise → Worker` 경로도 기록되어 있으므로 실제 개발 기준 저장소와 자동화 기준을 맞추어 문서를 정리할 필요가 있다. 이번 비교의 수정본 기준은 사용자가 지정한 로컬 Flowise와 그 origin이다.

**7. [조건부 높음] 배포 경로에 따라 수정본 소스가 아예 사용되지 않을 수 있다.**

루트 Dockerfile은 이 저장소를 빌드하지만 `docker/Dockerfile`은 `npm install -g flowise`로 npm 배포본을 설치한다. Docker Hub workflow의 main image는 후자를 사용한다. 해당 경로로 수정본을 배포하면 이 저장소의 커스텀 코드가 이미지에 포함되지 않는다. 현재 Render가 실제로 어떤 Dockerfile을 사용하는지는 이번 검토에서 조회하지 않았다. 향후 Node 업데이트 검증은 실제 운영 빌드 경로를 기준으로 해야 한다. [npm 배포본 설치 경로](../../docker/Dockerfile#L9), [Docker Hub workflow](../../.github/workflows/docker-image-dockerhub.yml#L47)

**추가 필수 조건: Render 배포 성공과 Node 업그레이드에 따른 의존성 호환성**

사용자가 추가로 명시한 완료 조건은 기존 커스텀 기능 보존, Render 배포 성공, Node 업데이트에 필요한 관련 라이브러리의 동반 업데이트다. 아래 항목을 구현의 완료 기준으로 적용한다.

| 검증 단계 | 통과 조건 |
| --- | --- |
| 실제 Render 설정 확인 | 두 서비스의 저장소·브랜치·서비스 유형·Dockerfile 경로·빌드 컨텍스트·시작 명령 override·리소스 제한을 확인하고 같은 조건으로 검증 |
| 의존성 설치 | Node·pnpm 버전을 고정하고, 새 store 및 Docker 빌드 캐시가 없는 상태에서 고정 lockfile 설치 성공 |
| 라이브러리 동반 업데이트 | Node engine, peer dependency, TypeScript 타입, ESM/CommonJS, 네이티브 모듈의 불일치를 해결하는 데 필요한 직접·간접 의존성과 소스를 함께 조정 |
| 빌드 | 두 저장소의 필요한 패키지와 실제 배포용 Docker 이미지가 빌드 메모리 제한 안에서 성공 |
| 기동 | Web의 포트 바인딩·설정된 헬스체크, Worker의 Redis 연결·작업 수신·완료, DB 접근 및 정상 종료 확인 |
| 기존 기능 | Vora 노드·임베드·스트리밍·중단·큐 복구 등 위에서 식별한 기능의 회귀 테스트 통과 |
| Render 배포 후 | 양쪽 대상 버전의 배포 성공, 실제 요청의 Web→Worker→Web 처리 성공, 업데이트로 인한 설치·기동·런타임 오류가 없는지 로그 확인 |

버전 충돌을 경고 억제나 `--force`만으로 숨긴 상태는 의존성 해결 완료로 취급하지 않는다. 호환성 문제가 있는 라이브러리는 필요한 범위에서 업데이트하고, API 변경에 대한 호출 코드·테스트·lockfile 수정까지 묶어서 처리한다. Render 배포 전 검증과 배포 후 검증은 각각 결과를 기록한다.

Render는 설정된 Dockerfile과 Docker Command에 따라 이미지를 빌드·기동하므로 저장소의 기본 명령만 확인해서는 충분하지 않다. 또한 Render의 헬스체크는 Web/private 서비스에 적용되며, background worker는 실제 큐 작업 처리와 로그로 준비 상태를 별도로 확인해야 한다. [Render Docker 공식 문서](https://render.com/docs/docker), [Render 헬스체크 공식 문서](https://render.com/docs/health-checks)

현재 세션에는 Render MCP 도구와 Render CLI가 없으며, 두 저장소에 추적되는 Render Blueprint도 확인되지 않았다. 따라서 Dashboard의 실제 서비스 설정과 배포 결과는 아직 확인하지 못했다. 이 항목은 실제 반영·배포 검증 단계에서 확인해야 하며, 로컬 빌드 성공만으로 Render 검증 완료를 선언하지 않는다.

**권고하는 반영 순서와 검증 범위**

먼저 현재 두 커밋을 기준선으로 기록하고 Node 24·pnpm 단일 버전·빌드 허용 설정을 정리한다. 다음으로 원본 `9291856d`를 비교 기준으로 의존성·소스·접근 제어 수정을 반영하면서 위의 커스텀 보강을 보존하고, Cloud 종료 정책은 별도 처리한다. 3.1.4 태그 이후에도 수정이 있으므로 태그만 반영하고 원본 최신 상태라고 판단하지 않는다. 이후 Worker 기준선 통합과 지속 동기화 검사를 추가한다.

구현 이후 통과해야 할 검증은 다음과 같다. 이번 검토에서 통과했다는 뜻은 아니다.

- 두 저장소에서 Node 24와 같은 pnpm 버전으로 새 store의 `pnpm install --frozen-lockfile` 실행. lockfile 재생성은 의도한 의존성 변경 단계에서 한 번 수행하고 이후 고정 설치로 검증한다.
- `pnpm lint`, `pnpm build`, `pnpm test` 및 실제 운영 Docker 경로의 캐시 없는 빌드. `build:docker`만으로 SDK 패키지 빌드까지 검증했다고 판단하지 않는다.
- VoraChatflowTool의 canvas 호출·사용자/워크스페이스 전달·하위 flow override, VoraRouter 모델 fallback, direct tool 반환·중복 실행 방지, sanitized progress 이벤트 검증.
- 같은 chatId의 동시 실행, relay 채널 분리, 클라이언트 연결 종료, 전체/개별 중단, Redis 재연결, 큐 완료 이벤트 복구와 정상 drain 검증.
- 공개 임베드의 스트리밍·중단, 익명/허가되지 않은 호출의 접근 제어, S3·파일 업로드·MCP·SQL 검증·SSO 회귀 테스트.
- 실제 사용하는 DB와 네이티브 모듈, Web/Worker 이미지 조합의 통합 실행. 이전 Worker와 새 Web의 조합을 사용할 수 있는지도 프로토콜 변경에 따라 판단한다.

**이번 검토의 증거와 한계**

원격 저장소 상태·릴리스·양쪽 원격 HEAD 확인, 임시 저장소 fetch, 공통 조상·패치 동등성·최종 트리 비교, 네 방향 모의 병합, manifest/lockfile/CI/Docker 설정과 주요 충돌 검토를 수행했다. 두 저장소에 node_modules가 없고 목표 Node 24도 현재 셸의 실행 버전이 아니므로 애플리케이션 설치·빌드·테스트는 실행하지 않았다. 운영 배포·DB·외부 서비스·비밀값은 조회하거나 변경하지 않았다.

모의 병합 로그와 원본 diff는 `/private/tmp/flowise-upstream-review-20261009-_n3j9wwr/`에 보관했다. 기존 Flowise 작업 트리의 `.gitignore`, AGENTS.md 수정 및 미추적 설정 파일은 보존했고, Worker 작업 트리는 변경하지 않았다.
