(function () {
  var st = window.__state();
  window.__probe = {
    windowed: st.windowed, overflow: st.overflow, pos: st.pos,
    membersCount: st.membersHeights.length,
    lastClip: st.clip, lastTf: st.tf,
    headerRect: (document.querySelector('#hostBubble .turn-batch-header').getBoundingClientRect().height)
  };
})()
