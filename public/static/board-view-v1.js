(function () {
  'use strict';

  // Filtering changes visibility, never the contents of an existing card. Keeping
  // those nodes also keeps drafts, open discussions, and in-flight write guards.
  function create(options) {
    var root = options.root;
    var controls = options.controls;
    var statuses = options.statuses;
    var admin = Boolean(options.admin);
    var features = [];
    var cards = new Map();
    var loaded = false;
    var selectedStatus = 'all';
    var view = options.defaultView || (window.matchMedia && window.matchMedia('(max-width: 760px)').matches ? 'list' : 'board');
    var laneLimits = {};
    var listLimit = 20;

    function make(tag, className, text) {
      var node = document.createElement(tag);
      if (className) node.className = className;
      if (text !== undefined) node.textContent = text;
      return node;
    }

    function button(label, className, action) {
      var node = make('button', className, label);
      node.type = 'button';
      node.addEventListener('click', action);
      return node;
    }

    function resetLimits() {
      listLimit = 20;
      statuses.forEach(function (status) { laneLimits[status.value] = 6; });
    }

    function filtersChanged() {
      resetLimits();
      render();
    }

    function selectField(label, id, choices, parent) {
      var field = make('label', 'board-filter-field');
      field.setAttribute('for', id);
      field.appendChild(make('span', null, label));
      var select = make('select');
      select.id = id;
      choices.forEach(function (choice) {
        var option = make('option', null, choice[1]);
        option.value = choice[0];
        select.appendChild(option);
      });
      select.value = choices[0][0];
      select.addEventListener('change', filtersChanged);
      field.appendChild(select);
      parent.appendChild(field);
      return select;
    }

    controls.textContent = '';
    controls.hidden = true;
    var toolbar = make('div', 'board-toolbar');
    controls.appendChild(toolbar);
    var searchField = make('label', 'board-search-field');
    searchField.setAttribute('for', 'board-search');
    searchField.appendChild(make('span', null, 'Search roadmap'));
    var search = make('input');
    search.id = 'board-search';
    search.type = 'search';
    search.autocomplete = 'off';
    search.placeholder = 'Search titles, details, or issue numbers';
    search.value = '';
    search.addEventListener('input', filtersChanged);
    searchField.appendChild(search);
    toolbar.appendChild(searchField);

    var row = make('div', 'board-toolbar-row');
    var tabs = make('div', 'board-status-tabs');
    tabs.setAttribute('role', 'group');
    tabs.setAttribute('aria-label', 'Roadmap status');
    var statusButtons = [{ value: 'all', label: 'All' }].concat(statuses).map(function (status) {
      var node = button(status.label, 'board-status-tab', function () {
        selectedStatus = status.value;
        filtersChanged();
      });
      node.dataset.status = status.value;
      tabs.appendChild(node);
      return { node: node, value: status.value, label: status.label };
    });
    row.appendChild(tabs);
    var viewSwitch = make('div', 'board-view-switch');
    viewSwitch.setAttribute('role', 'group');
    viewSwitch.setAttribute('aria-label', 'Display');
    var viewButtons = ['board', 'list'].map(function (name) {
      var node = button(name === 'board' ? 'Board' : 'List', null, function () {
        view = name;
        render();
      });
      node.dataset.view = name;
      viewSwitch.appendChild(node);
      return { node: node, value: name };
    });
    row.appendChild(viewSwitch);
    toolbar.appendChild(row);

    var filterRow = make('div', 'board-toolbar-row');
    var filters = make('details', 'board-filters');
    var filterSummary = make('summary', null, 'Filters');
    filters.appendChild(filterSummary);
    var grid = make('div', 'board-filter-grid');
    filters.appendChild(grid);
    var issue = selectField('GitHub issue', 'board-issue-filter', [
      ['all', 'Any issue'], ['linked', 'Linked issue'], ['missing', 'No linked issue']
    ], grid);
    var response = selectField('Maintainer response', 'board-response-filter', [
      ['all', 'Any response'], ['present', 'Has a response'], ['missing', 'No response']
    ], grid);
    var commentChoices = [['all', 'Any comments'], ['present', 'Has comments'], ['missing', 'No comments']];
    if (admin) commentChoices.push(['pending', 'Pending comments']);
    var comments = selectField('Comments', 'board-comment-filter', commentChoices, grid);
    var contact = admin ? selectField('Private contact', 'board-contact-filter', [
      ['all', 'Any contact'], ['present', 'Has contact'], ['missing', 'No contact']
    ], grid) : null;
    filterRow.appendChild(filters);
    var sort = selectField('Sort', 'board-sort', [
      ['votes', 'Most upvotes'], ['newest', 'Newest first'], ['oldest', 'Oldest first'], ['title', 'Title A–Z']
    ], filterRow);
    toolbar.appendChild(filterRow);
    var resultRow = make('div', 'board-toolbar-row');
    var results = make('p', 'board-results');
    results.setAttribute('role', 'status');
    results.setAttribute('aria-live', 'polite');
    resultRow.appendChild(results);
    var reset = button('Clear filters', 'board-reset', function () {
      resetFilters();
      filtersChanged();
    });
    resultRow.appendChild(reset);
    toolbar.appendChild(resultRow);

    var lanes = make('div', 'board-lanes');
    var laneViews = statuses.map(function (status) {
      var section = make('section', 'board-lane');
      section.dataset.status = status.value;
      var head = make('div', 'board-lane-head');
      var heading = make('h2', null, status.label);
      heading.id = 'board-lane-' + status.value;
      section.setAttribute('aria-labelledby', heading.id);
      head.appendChild(heading);
      var count = make('span', 'board-lane-count');
      head.appendChild(count);
      section.appendChild(head);
      var list = make('ol', 'board-cards');
      section.appendChild(list);
      var empty = make('p', 'board-empty', 'No matching ideas.');
      section.appendChild(empty);
      var more = button('Show more', 'board-more', function () {
        var oldLimit = laneLimits[status.value];
        var matches = selectedFeatures().filter(function (feature) { return feature.status === status.value; }).sort(compare);
        laneLimits[status.value] += 6;
        render();
        focusCard(matches[oldLimit]);
      });
      section.appendChild(more);
      lanes.appendChild(section);
      return { value: status.value, label: status.label, section: section, list: list, count: count, empty: empty, more: more };
    });
    var listView = make('div', 'board-list-view');
    var list = make('ol', 'board-cards');
    list.setAttribute('aria-label', 'Matching roadmap ideas');
    listView.appendChild(list);
    var listMore = button('Show more', 'board-more', function () {
      var oldLimit = listLimit;
      var matches = selectedFeatures().sort(listCompare);
      listLimit += 20;
      render();
      focusCard(matches[oldLimit]);
    });
    listView.appendChild(listMore);
    var empty = make('p', 'board-empty');

    function resetFilters() {
      selectedStatus = 'all';
      search.value = '';
      issue.value = response.value = comments.value = 'all';
      if (contact) contact.value = 'all';
      sort.value = 'votes';
    }

    function has(value) { return typeof value === 'string' && value.trim().length > 0; }
    function count(value) { return Number.isFinite(value) ? value : 0; }
    function presence(value, present) { return value === 'all' || (value === 'present' ? present : !present); }

    function selectedFeatures() {
      var terms = search.value.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
      return features.filter(function (feature) {
        if (selectedStatus !== 'all' && feature.status !== selectedStatus) return false;
        if (issue.value !== 'all' && (issue.value === 'linked') !== has(feature.githubIssueUrl)) return false;
        if (!presence(response.value, has(feature.maintainerResponse))) return false;
        var commentCount = count(feature.commentCount) + (admin ? count(feature.pendingCommentCount) : 0);
        if (comments.value === 'pending' ? !count(feature.pendingCommentCount) : !presence(comments.value, commentCount > 0)) return false;
        if (contact && !presence(contact.value, has(feature.contactEmail) || has(feature.contactDiscord))) return false;
        // Private contact data is intentionally not searchable or copied into URLs.
        var issueNumber = String(feature.githubIssueUrl || '').match(/\/issues\/([1-9]\d*)$/);
        var text = [feature.title, feature.detail, feature.maintainerResponse, '#' + feature.id, feature.githubIssueUrl,
          issueNumber ? '#' + issueNumber[1] : '']
          .join(' ').toLocaleLowerCase();
        return terms.every(function (term) { return text.indexOf(term) !== -1; });
      });
    }

    function oldest(a, b) {
      return String(a.createdAt || '').localeCompare(String(b.createdAt || '')) || count(a.id) - count(b.id);
    }

    function compare(a, b) {
      if (sort.value === 'newest') return -oldest(a, b);
      if (sort.value === 'oldest') return oldest(a, b);
      if (sort.value === 'title') return String(a.title).localeCompare(String(b.title), undefined, { sensitivity: 'base' }) || oldest(a, b);
      return count(b.upvotes) - count(a.upvotes) || count(a.downvotes) - count(b.downvotes) || oldest(a, b);
    }

    function listCompare(a, b) {
      if (admin && sort.value === 'votes' && (a.status === 'pending') !== (b.status === 'pending')) {
        return a.status === 'pending' ? -1 : 1;
      }
      return compare(a, b);
    }

    function focusCard(feature) {
      var card = feature && cards.get(feature.id);
      if (card && card.focus) card.focus();
    }

    function place(list, ordered, matching, limit) {
      var visible = new Set(matching.slice(0, limit).map(function (feature) { return feature.id; }));
      ordered.forEach(function (feature, index) {
        var card = cards.get(feature.id);
        if (list.children[index] !== card) list.insertBefore(card, list.children[index] || null);
        card.hidden = !visible.has(feature.id);
      });
      return visible.size;
    }

    function render() {
      if (!loaded) return;
      var focused = document.activeElement;
      var matches = selectedFeatures();
      var advanced = [issue, response, comments, contact].filter(function (field) { return field && field.value !== 'all'; }).length;
      filterSummary.textContent = 'Filters' + (advanced ? ' (' + advanced + ')' : '');
      reset.hidden = !(search.value || selectedStatus !== 'all' || advanced || sort.value !== 'votes');
      statusButtons.forEach(function (status) {
        var total = status.value === 'all' ? features.length : features.filter(function (feature) { return feature.status === status.value; }).length;
        status.node.textContent = status.label + ' (' + total + ')';
        status.node.setAttribute('aria-pressed', String(selectedStatus === status.value));
      });
      viewButtons.forEach(function (button) { button.node.setAttribute('aria-pressed', String(view === button.value)); });
      root.dataset.view = view;
      lanes.hidden = view !== 'board' || !matches.length;
      listView.hidden = view !== 'list' || !matches.length;
      empty.hidden = matches.length > 0;
      empty.textContent = features.length ? 'No ideas match these filters. Clear filters to see the full roadmap.' : 'No ideas on the board yet.';
      var shown = 0;
      if (view === 'board') {
        laneViews.forEach(function (lane) {
          var all = features.filter(function (feature) { return feature.status === lane.value; }).sort(compare);
          var matching = matches.filter(function (feature) { return feature.status === lane.value; }).sort(compare);
          lane.section.hidden = selectedStatus !== 'all' && selectedStatus !== lane.value;
          lane.count.textContent = matching.length === all.length ? String(all.length) : matching.length + ' of ' + all.length;
          lane.count.setAttribute('aria-label', matching.length + ' matching of ' + all.length + ' ' + lane.label.toLocaleLowerCase() + ' ideas');
          shown += place(lane.list, all, matching, laneLimits[lane.value]);
          lane.empty.hidden = matching.length > 0;
          var remaining = Math.max(0, matching.length - laneLimits[lane.value]);
          lane.more.hidden = remaining === 0;
          lane.more.textContent = 'Show ' + Math.min(6, remaining) + ' more (' + remaining + ' remaining)';
          lane.more.setAttribute('aria-label', 'Show more ' + lane.label.toLocaleLowerCase() + ' ideas, ' + remaining + ' remaining');
        });
      } else {
        shown = place(list, features.slice().sort(listCompare), matches.slice().sort(listCompare), listLimit);
        var remaining = Math.max(0, matches.length - listLimit);
        listMore.hidden = remaining === 0;
        listMore.textContent = 'Show ' + Math.min(20, remaining) + ' more (' + remaining + ' remaining)';
        listMore.setAttribute('aria-label', 'Show more roadmap ideas, ' + remaining + ' remaining');
      }
      results.textContent = 'Showing ' + shown + ' of ' + matches.length + ' matching ' + (matches.length === 1 ? 'idea' : 'ideas') + '. ' + features.length + ' total.';
      // Moving a focused card while sorting can blur its button or editor.
      if (focused && root.contains && root.contains(focused)) {
        var ancestor = focused;
        var concealed = false;
        while (ancestor && ancestor !== root) {
          if (ancestor.hidden) concealed = true;
          ancestor = ancestor.parentNode;
        }
        if (concealed && search.focus) search.focus({ preventScroll: true });
        else if (focused.focus && document.activeElement !== focused) focused.focus({ preventScroll: true });
      }
      if (options.onChange) options.onChange();
    }

    resetLimits();
    return {
      setItems: function (items) {
        features = items.filter(function (feature) { return statuses.some(function (status) { return status.value === feature.status; }); });
        cards.clear();
        laneViews.forEach(function (lane) { lane.list.textContent = ''; });
        list.textContent = '';
        features.forEach(function (feature) {
          var card = options.renderItem(feature);
          card.tabIndex = -1;
          cards.set(feature.id, card);
        });
        root.textContent = '';
        root.appendChild(lanes);
        root.appendChild(listView);
        root.appendChild(empty);
        loaded = true;
        controls.hidden = false;
        render();
      },
      refresh: render,
      clear: function () {
        loaded = false;
        features = [];
        cards.clear();
        laneViews.forEach(function (lane) { lane.list.textContent = ''; });
        list.textContent = '';
        root.textContent = '';
        controls.hidden = true;
        results.textContent = '';
        resetFilters();
        resetLimits();
      }
    };
  }

  window.RoadmapBoard = { create: create };
})();
