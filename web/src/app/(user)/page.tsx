import type { Metadata } from "next";
import Link from "next/link";
import { ProjectIcon } from "@/components/ui/project-icon";
import styles from "./landing.module.css";

export const metadata: Metadata = {
    title: "映序 Studio · 项目创作工作站",
    description: "从项目开始，在画布中整理故事与镜头，为制作申请项目积分。",
};

const steps = [
    { title: "创建项目", description: "登录后创建项目，由你担任制作组长，组织这个项目的创作。" },
    { title: "免费筹备", description: "整理文本画布、人物场景与图片提示词，不必等待积分审批。" },
    { title: "申请总积分", description: "按制作需要申请项目总额度，已有额度与追加申请分别记录。" },
    { title: "管理员审批", description: "获批额度归入项目。后续 AI 制作将统一使用项目积分。" },
];

export default function LandingPage() {
    return (
        <main className={styles.page} data-testid="landing-page">
            <a className={styles.skipLink} href="#workflow">跳到制作流程</a>
            <div className={styles.container}>
                <header className={styles.header}>
                    <Link href="/" className={styles.brand} aria-label="映序 Studio 首页" prefetch={false}>
                        <span className={styles.logo} aria-hidden="true" />
                        <span>映序 <span className={styles.brandEnglish}>Studio</span></span>
                    </Link>
                    <nav className={styles.navigation} aria-label="首页导航">
                        <a href="#workflow">制作流程</a>
                        <a href="#capabilities">当前能力</a>
                    </nav>
                    <Link href="/projects" className={styles.headerEntry} prefetch={false}>进入工作台</Link>
                </header>

                <section className={styles.hero} aria-labelledby="landing-heading">
                    <div className={styles.heroCopy}>
                        <h1 id="landing-heading">让创作，<br />从一个项目开始。</h1>
                        <p className={styles.introduction}>把故事的线索铺进画布，<br />让每一次筹备，都留在自己的项目里。</p>
                        <div className={styles.heroActions}>
                            <Link href="/projects" className={styles.primaryAction} prefetch={false}>进入工作台</Link>
                            <a href="#workflow" className={styles.textAction}>了解制作流程</a>
                        </div>
                        <p className={styles.heroNote}>文本画布、资产筹备与项目预算已开放，AI 制作正在接入。</p>
                    </div>

                    <figure className={styles.diagram} aria-labelledby="diagram-caption">
                        <div className={styles.diagramSurface}>
                            <svg className={styles.connections} viewBox="0 0 580 410" fill="none" aria-hidden="true">
                                <path className={styles.connectionBase} d="M170 86H189Q204 86 204 101V306Q204 322 220 322H240M204 151H240" />
                                <path className={styles.connectionLight} d="M170 86H189Q204 86 204 101V306Q204 322 220 322H240M204 151H240" pathLength="1" />
                                <circle cx="204" cy="151" r="3" fill="#D5D9DF" />
                            </svg>
                            <div className={styles.projectNode}>
                                <span className={styles.projectGlyph}><ProjectIcon name="projects" /></span>
                                <strong>一个项目</strong>
                                <span>独立的创作空间</span>
                            </div>
                            <div className={styles.canvasNode}>
                                <div className={styles.canvasHeader}>
                                    <span><ProjectIcon name="canvas" /> 画面创作</span>
                                    <span className={styles.availableLabel}>已开放</span>
                                </div>
                                <div className={styles.canvasPreview}>
                                    <div className={styles.textNode}>
                                        <span className={styles.nodeLabel}><ProjectIcon name="text" /> 故事线索</span>
                                        <p>一个想法，<br />在这里慢慢成形。</p>
                                    </div>
                                    <span className={styles.nodeConnector} aria-hidden="true" />
                                    <div className={styles.shotNode}>
                                        <span className={styles.nodeLabel}>镜头节奏</span>
                                        <span className={styles.shotLine} />
                                        <span className={styles.shotLine} />
                                        <span className={styles.shotLine} />
                                    </div>
                                </div>
                                <div className={styles.canvasFooter}>文本 <span /> 分组 <span /> 连线</div>
                            </div>
                            <div className={styles.assetNode}>
                                <span className={styles.assetGlyph}><ProjectIcon name="assets" /></span>
                                <div><strong>资产创意</strong><span>人物场景，提示词筹备</span></div>
                                <span className={styles.plannedLabel}>已开放</span>
                            </div>
                        </div>
                        <figcaption id="diagram-caption">项目空间示意<span>创作内容按项目组织</span></figcaption>
                    </figure>
                </section>

                <section id="workflow" className={styles.workflow} aria-labelledby="workflow-heading" tabIndex={-1}>
                    <div className={styles.sectionHeading}>
                        <h2 id="workflow-heading">从想法，到有序的筹备。</h2>
                        <p>先整理内容，再规划制作所需的项目额度。</p>
                    </div>
                    <ol className={styles.steps}>
                        {steps.map((step, index) => (
                            <li key={step.title}>
                                <span className={styles.stepNumber}>{String(index + 1).padStart(2, "0")}</span>
                                <h3>{step.title}</h3>
                                <p>{step.description}</p>
                            </li>
                        ))}
                    </ol>
                </section>

                <section id="capabilities" className={styles.capabilities} aria-labelledby="capabilities-heading" tabIndex={-1}>
                    <div className={styles.capabilitiesHeading}>
                        <h2 id="capabilities-heading">现在，就能开始。</h2>
                        <p>让项目、画布与预算，<br />沿着同一条制作线展开。</p>
                    </div>
                    <div className={styles.featureList}>
                        <article className={styles.feature}>
                            <ProjectIcon name="projects" />
                            <div><h3>项目有自己的空间</h3><p>从项目进入画布，建立人物与场景资料，保存各自的图片提示词和参数。项目只对创建者和当前制作组长可见。</p></div>
                        </article>
                        <article className={styles.feature}>
                            <ProjectIcon name="canvas" />
                            <div><h3>把想法留在画布里</h3><p>在项目中建立多份画布文档，用文本、分组与连线整理创意，保存后随时回来接着写。</p></div>
                        </article>
                        <article className={styles.feature}>
                            <ProjectIcon name="budget" />
                            <div><h3>为项目申请制作额度</h3><p>制作组长申请项目所需的总积分，管理员审批与拨付。免费筹备不受审批进度影响。</p></div>
                        </article>
                        <aside className={styles.upcoming} aria-label="后续建设内容">
                            <span>接下来</span>
                            <p>项目图片可上传并引用到画布；剧本分析、AI 图片/视频生成及积分结算尚未开放。</p>
                        </aside>
                    </div>
                </section>

                <footer className={styles.footer}>
                    <div><span className={styles.footerBrand}>映序 Studio</span><p>基于 <a href="https://github.com/tigerowo/infinite-canvas" target="_blank" rel="noreferrer">tigerowo / Infinite Canvas</a> 独立开发 · AGPL-3.0</p></div>
                    <Link href="/projects" className={styles.footerEntry} prefetch={false}>进入工作台</Link>
                </footer>
            </div>
        </main>
    );
}
