"use strict";

const PRODUCTIVE_GIST_ID = process.env.PRODUCTIVE_GIST_ID;
const STATS_GIST_ID = process.env.STATS_GIST_ID;
const TIMEZONE = process.env.TIMEZONE || "Asia/Seoul";
const ALL_COMMITS = process.env.ALL_COMMITS === "true";
const K_FORMAT = process.env.K_FORMAT === "true";

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

async function updateProductiveBox(github, core) {
  const { viewer } = await github.graphql(`
    query {
      viewer {
        id
        login
      }
    }
  `);

  const { user } = await github.graphql(
    `
      query ($login: String!) {
        user(login: $login) {
          repositoriesContributedTo(last: 100, includeUserRepositories: true) {
            nodes {
              isFork
              name
              owner {
                login
              }
            }
          }
        }
      }
    `,
    { login: viewer.login },
  );

  const repositories = (user?.repositoriesContributedTo?.nodes || []).filter(
    (repository) => repository && !repository.isFork,
  );
  const committedDates = [];

  for (let index = 0; index < repositories.length; index += 10) {
    const batch = repositories.slice(index, index + 10);
    const histories = await Promise.all(
      batch.map(async (repository) => {
        try {
          const result = await github.graphql(
            `
              query ($owner: String!, $name: String!, $authorId: ID!) {
                repository(owner: $owner, name: $name) {
                  defaultBranchRef {
                    target {
                      ... on Commit {
                        history(first: 100, author: { id: $authorId }) {
                          nodes {
                            committedDate
                          }
                        }
                      }
                    }
                  }
                }
              }
            `,
            {
              owner: repository.owner.login,
              name: repository.name,
              authorId: viewer.id,
            },
          );

          return (
            result.repository?.defaultBranchRef?.target?.history?.nodes || []
          ).map((commit) => commit.committedDate);
        } catch (error) {
          core.warning(
            `Skipped ${repository.owner.login}/${repository.name}: ${error.message}`,
          );
          return [];
        }
      }),
    );

    committedDates.push(...histories.flat());
  }

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
    const { data } = await github.request("GET /search/commits", {
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
