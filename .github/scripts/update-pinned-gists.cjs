"use strict";

const PRODUCTIVE_GIST_ID = process.env.PRODUCTIVE_GIST_ID;
const STATS_GIST_ID = process.env.STATS_GIST_ID;
const TIMEZONE = process.env.TIMEZONE || "Asia/Seoul";
const ALL_COMMITS = process.env.ALL_COMMITS === "true";
const K_FORMAT = process.env.K_FORMAT === "true";
const SEARCH_PAGE_SIZE = 100;
const SEARCH_RESULT_LIMIT = 1000;
const SEARCH_REQUEST_INTERVAL_MS = 2100;
const MILLISECONDS_PER_SECOND = 1000;
let lastSearchRequestAt = 0;

function requireValue(name, value) {
  if (!value) {
    throw new Error(`${name} is not configured`);
  }

  return value;
}

async function updateGist(github, core, gistId, filename, content) {
  const { data: gist } = await github.rest.gists.get({ gist_id: gistId });
  const files = Object.entries(gist.files || {}).filter(([, file]) => file);

  if (files.length === 0) {
    throw new Error(`Gist ${gistId} does not contain a file`);
  }

  const [currentFilename, currentFile] = files[0];
  if (currentFilename === filename && currentFile.content === content) {
    core.info(`Gist ${gistId} is already up to date`);
    return;
  }

  await github.rest.gists.update({
    gist_id: gistId,
    files: {
      [currentFilename]: {
        filename,
        content,
      },
    },
  });

  core.info(`Updated Gist ${gistId}`);
}

function makeBarChart(percent, size = 21) {
  const symbols = "░▏▎▍▌▋▊▉█";
  const fraction = Math.floor((size * 8 * percent) / 100);
  const fullBars = Math.floor(fraction / 8);

  if (fullBars >= size) {
    return symbols[8].repeat(size);
  }

  const partialBar = symbols[fraction % 8];
  return `${symbols[8].repeat(fullBars)}${partialBar}`.padEnd(size, symbols[0]);
}

function hourInTimezone(date, timezone) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    hour: "2-digit",
    hourCycle: "h23",
    timeZone: timezone,
  });

  return Number(formatter.format(new Date(date)));
}

function formatSearchTimestamp(date) {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function splitDateRange(from, to) {
  const fromTime = Date.parse(from);
  const toTime = Date.parse(to);
  const spanInSeconds = Math.floor(
    (toTime - fromTime) / MILLISECONDS_PER_SECOND,
  );

  if (spanInSeconds < 1) return null;

  const leftEndTime =
    fromTime + Math.floor(spanInSeconds / 2) * MILLISECONDS_PER_SECOND;
  return {
    left: [from, formatSearchTimestamp(new Date(leftEndTime))],
    right: [
      formatSearchTimestamp(new Date(leftEndTime + MILLISECONDS_PER_SECOND)),
      to,
    ],
  };
}

function addSearchResults(commits, items) {
  for (const item of items) {
    if (!item?.sha || !item.repository || item.repository.fork) continue;

    const committedDate = item.commit?.committer?.date;
    if (!committedDate) continue;

    const repository = item.repository.id || item.repository.full_name;
    commits.set(`${repository}:${item.sha}`, committedDate);
  }
}

async function requestCommitSearchApi(github, parameters) {
  const waitTime =
    lastSearchRequestAt + SEARCH_REQUEST_INTERVAL_MS - Date.now();

  if (waitTime > 0) {
    await new Promise((resolve) => setTimeout(resolve, waitTime));
  }

  const response = await github.request("GET /search/commits", parameters);
  lastSearchRequestAt = Date.now();
  return response;
}

async function requestCommitSearch(github, login, from, to, page) {
  const { data } = await requestCommitSearchApi(github, {
    q: `author:${login} committer-date:${from}..${to}`,
    sort: "committer-date",
    order: "asc",
    per_page: SEARCH_PAGE_SIZE,
    page,
    headers: {
      accept: "application/vnd.github+json",
    },
  });

  return data;
}

async function collectSplitRanges(github, core, login, from, to, commits) {
  const ranges = splitDateRange(from, to);
  if (!ranges) {
    throw new Error(
      `GitHub could not return a complete commit search for the one-second range ${from}..${to}`,
    );
  }

  await collectCommitsForRange(
    github,
    core,
    login,
    ranges.left[0],
    ranges.left[1],
    commits,
  );
  await collectCommitsForRange(
    github,
    core,
    login,
    ranges.right[0],
    ranges.right[1],
    commits,
  );
}

async function collectCommitsForRange(github, core, login, from, to, commits) {
  const firstPage = await requestCommitSearch(github, login, from, to, 1);
  const mustSplit =
    firstPage.incomplete_results || firstPage.total_count > SEARCH_RESULT_LIMIT;

  core.info(
    `Commit search ${from}..${to}: ${firstPage.total_count} result(s)` +
      (firstPage.incomplete_results ? " (incomplete)" : ""),
  );

  if (mustSplit) {
    return collectSplitRanges(github, core, login, from, to, commits);
  }

  addSearchResults(commits, firstPage.items || []);
  let pageCount = Math.ceil(firstPage.total_count / SEARCH_PAGE_SIZE);

  for (let page = 2; page <= pageCount; page += 1) {
    const result = await requestCommitSearch(github, login, from, to, page);
    if (result.incomplete_results || result.total_count > SEARCH_RESULT_LIMIT) {
      core.warning(
        `Commit search changed while reading ${from}..${to}; retrying smaller ranges`,
      );
      return collectSplitRanges(github, core, login, from, to, commits);
    }

    if (result.total_count !== firstPage.total_count) {
      core.warning(
        `Commit search count for ${from}..${to} changed from ${firstPage.total_count} to ${result.total_count}`,
      );
      pageCount = Math.max(
        pageCount,
        Math.ceil(result.total_count / SEARCH_PAGE_SIZE),
      );
    }

    addSearchResults(commits, result.items || []);
  }
}

async function updateProductiveBox(github, core) {
  const { viewer } = await github.graphql(`
    query {
      viewer {
        createdAt
        login
      }
    }
  `);

  const now = new Date();
  const from = formatSearchTimestamp(new Date(viewer.createdAt));
  const to = formatSearchTimestamp(now);
  const commits = new Map();

  await collectCommitsForRange(github, core, viewer.login, from, to, commits);
  const committedDates = [...commits.values()];
  core.info(
    `Collected ${committedDates.length} unique non-fork commits from ${from} through ${to}`,
  );

  const periods = [
    { label: "🌞 Morning", commits: 0 },
    { label: "🌆 Daytime", commits: 0 },
    { label: "🌃 Evening", commits: 0 },
    { label: "🌙 Night", commits: 0 },
  ];

  for (const committedDate of committedDates) {
    const hour = hourInTimezone(committedDate, TIMEZONE);

    if (hour >= 6 && hour < 12) periods[0].commits += 1;
    else if (hour >= 12 && hour < 18) periods[1].commits += 1;
    else if (hour >= 18) periods[2].commits += 1;
    else periods[3].commits += 1;
  }

  const total = periods.reduce((sum, period) => sum + period.commits, 0);
  if (total === 0) {
    throw new Error("No commit timestamps were available for productive-box");
  }

  const content =
    periods
      .map((period) => {
        const percent = (period.commits / total) * 100;
        return [
          period.label.padEnd(10),
          `${String(period.commits).padStart(5)} commits`.padEnd(14),
          makeBarChart(percent),
          `${percent.toFixed(1).padStart(5)}%`,
        ].join(" ");
      })
      .join("\n") + "\n";

  const daytimeCommits = periods[0].commits + periods[1].commits;
  const nighttimeCommits = periods[2].commits + periods[3].commits;
  const filename =
    daytimeCommits > nighttimeCommits ? "I'm an early 🐤" : "I'm a night 🦉";

  await updateGist(
    github,
    core,
    requireValue("PRODUCTIVE_GIST_ID", PRODUCTIVE_GIST_ID),
    filename,
    content,
  );
}

function formatNumber(value, compact) {
  if (value < 1000) return String(value);
  if (!compact) return new Intl.NumberFormat("en-US").format(value);

  const units = [
    [1_000_000_000_000, "t"],
    [1_000_000_000, "b"],
    [1_000_000, "m"],
    [1_000, "k"],
  ];
  const [divisor, suffix] = units.find(([threshold]) => value >= threshold);
  return `${(value / divisor).toFixed(1)}${suffix}`;
}

async function collectStats(github) {
  let cursor = null;
  let stats = null;

  do {
    const { viewer } = await github.graphql(
      `
        query ($cursor: String) {
          viewer {
            name
            login
            contributionsCollection {
              totalCommitContributions
            }
            repositoriesContributedTo(
              first: 1
              contributionTypes: [COMMIT, ISSUE, PULL_REQUEST, REPOSITORY]
            ) {
              totalCount
            }
            pullRequests(first: 1) {
              totalCount
            }
            issues(first: 1) {
              totalCount
            }
            repositories(
              first: 100
              after: $cursor
              ownerAffiliations: [OWNER]
              isFork: false
              orderBy: { direction: DESC, field: STARGAZERS }
            ) {
              nodes {
                stargazerCount
              }
              pageInfo {
                endCursor
                hasNextPage
              }
            }
          }
        }
      `,
      { cursor },
    );

    if (!stats) {
      stats = {
        name: viewer.name || viewer.login,
        login: viewer.login,
        totalPRs: viewer.pullRequests.totalCount,
        totalCommits: viewer.contributionsCollection.totalCommitContributions,
        totalIssues: viewer.issues.totalCount,
        totalStars: 0,
        contributedTo: viewer.repositoriesContributedTo.totalCount,
      };
    }

    stats.totalStars += viewer.repositories.nodes.reduce(
      (sum, repository) => sum + repository.stargazerCount,
      0,
    );

    cursor = viewer.repositories.pageInfo.hasNextPage
      ? viewer.repositories.pageInfo.endCursor
      : null;
  } while (cursor);

  if (ALL_COMMITS) {
    const { data } = await requestCommitSearchApi(github, {
      q: `author:${stats.login}`,
      per_page: 1,
      headers: {
        accept: "application/vnd.github+json",
      },
    });
    stats.totalCommits = data.total_count;
  }

  return stats;
}

async function updateStatsBox(github, core) {
  const stats = await collectStats(github);
  const rows = [
    ["⭐", "Total Stars", stats.totalStars],
    [
      "➕",
      ALL_COMMITS ? "Total Commits" : "Past Year Commits",
      stats.totalCommits,
    ],
    ["🔀", "Total PRs", stats.totalPRs],
    ["🚩", "Total Issues", stats.totalIssues],
    ["📦", "Contributed to", stats.contributedTo],
  ];

  const content =
    rows
      .map(([icon, label, value]) => {
        const formattedValue = formatNumber(value, K_FORMAT);
        const line = `${label}:${formattedValue}`;
        const spaces = " ".repeat(Math.max(1, 45 - line.length));
        return `${icon}    ${label}:${spaces}${formattedValue}`;
      })
      .join("\n") + "\n";

  await updateGist(
    github,
    core,
    requireValue("STATS_GIST_ID", STATS_GIST_ID),
    `${stats.name}'s GitHub Stats`,
    content,
  );
}

module.exports = async ({ github, core }) => {
  const failures = [];
  const updates = [
    ["productive-box", updateProductiveBox],
    ["github-stats-box", updateStatsBox],
  ];

  for (const [name, update] of updates) {
    try {
      await update(github, core);
    } catch (error) {
      failures.push(name);
      core.error(`${name}: ${error.stack || error.message}`);
    }
  }

  if (failures.length > 0) {
    throw new Error(`Failed to update: ${failures.join(", ")}`);
  }
};
