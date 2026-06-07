import { prisma } from "../src/db/prisma.js";
import { repairAnchorDispatchQueueProjectScope } from "../src/modules/anchor-broker/anchor-dispatch-queue-project-scope.js";

const report = await repairAnchorDispatchQueueProjectScope(prisma);
console.log(JSON.stringify({ migration: "anchor_dispatch_queue_project_id", report }, null, 2));
await prisma.$disconnect();
